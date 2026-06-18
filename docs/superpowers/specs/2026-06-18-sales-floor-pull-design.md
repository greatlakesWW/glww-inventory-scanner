# Sales Floor Pull — Design Spec

**Date:** 2026-06-18
**Module:** Item Receipts (`src/modules/ItemReceipts.jsx`) + shared pick engine
**Status:** Approved design, pending implementation plan

## Summary

After a worker creates an Item Receipt against a Purchase Order, they can tap
**"Start Sales Floor Pull"** to move just-received stock onto the Sales Floor for
selling. The feature auto-creates a Transfer Order (receiving location → Sales
Floor) for received items that currently have **zero** on-hand at Sales Floor,
sized to each item's Sales-Floor preferred stock level, then walks the worker
through a single bin-guided pick. On completion it fulfills and receives the TO
behind the scenes so the stock lands in the Sales Floor bin `F-01-0001`.

## Goals

- One-tap path from "PO received" to "stock on the floor," continuous on the handheld.
- Only restock items that are absent from the floor (floor qty = 0).
- Stock the floor to the item's intended level, never more than was just received.
- Surface — not silently drop — items that can't be sized because no preferred
  level is configured.

## Non-Goals

- Restocking items that already have any presence on the floor (floor qty > 0).
  Those are out of scope for this flow.
- Replenishing the floor from existing back stock unrelated to this receipt.
- A standalone "Sales Floor Pull" entry point. The flow is reached only from a
  completed receipt's summary screen.

## User Flow

1. Worker completes an Item Receipt (existing flow). The summary screen renders.
2. The app evaluates pull candidates (see **Candidate Rules**). If at least one
   item qualifies, a green **"Start Sales Floor Pull"** button appears. If none
   qualify (e.g. the PO was received directly to Sales Floor, or every received
   item already has floor stock), the button is hidden.
3. Worker taps the button. The app creates the Transfer Order and drops straight
   into a bin-guided pick of the received bins (same screens as Transfer Orders
   outbound).
4. Worker scans items out of the back bins. On completion the app:
   a. fires the **Item Fulfillment** transform (ship from source), then
   b. fires the **Item Receipt** transform into bin `F-01-0001` (no second scan
      pass — the destination bin is fixed).
5. A summary screen shows the TO number, what moved, and a **"Not transferred —
   set a Sales Floor level"** notice listing any items skipped for lack of a
   preferred level.

## Candidate Rules

For each item on the just-created receipt (`receivedItems` in `ItemReceipts.jsx`):

| Condition | Outcome |
|---|---|
| Floor on-hand > 0 | **Skip** — already present on the floor. |
| Floor on-hand = 0 AND preferred level > 0 | **Include.** TO qty = `min(received this receipt, preferred level)`. |
| Floor on-hand = 0 AND no preferred level (unset or 0) | **Notify.** Listed in the summary notice; not added to the TO. |

- "Received this receipt" = the quantity the worker scanned in the receipt that
  just completed (`receivedItems[itemId]`), not the PO line total.
- "Floor on-hand" = sum of `inventorybalance.quantityonhand` for the item at the
  Sales Floor location (id `1`).
- The TO **source** location is the PO's receiving location. If that location IS
  Sales Floor, no items can qualify and the button is hidden.

## Architecture

### New / changed pieces

1. **Shared pick engine** — extract `buildPickPlan` and the bin-guided
   pick/scan UI currently living in `src/modules/TransferOrders.jsx` into a
   shared helper (e.g. `src/shared/pickFlow.jsx` or similar) so both Transfer
   Orders and the Sales Floor Pull use one implementation. No behavior change to
   the existing Transfer Orders module.

2. **Item Receipts pull phases** — add phases to `ItemReceipts.jsx` after
   `summary`: `pull-pick` (bin-guided pick) and `pull-done` (summary). State
   seeded from the receipt that just completed.

3. **Candidate query** — SuiteQL run when the receipt summary renders (or when
   the button is tapped), returning, per received item: Sales-Floor on-hand and
   Sales-Floor preferred stock level. See **Open Verification** for the
   preferred-level source.

4. **TO creation** — reuse `api/record.js` (generic REST record proxy):
   `POST record/v1/transferOrder` with header (subsidiary, source location,
   destination = Sales Floor, date) and item lines (item id + quantity). No
   inventory detail is set at creation, so the static-sublist trap that pushed
   receipts onto RESTlets does not apply here.

5. **Fulfill + receive** — reuse the raw-REST transforms already used by
   `TransferOrders.jsx`:
   - `POST transferOrder/{id}/!transform/itemFulfillment` (ship from source).
   - `POST transferOrder/{id}/!transform/itemReceipt` with each line's
     `inventoryDetail.inventoryAssignment` targeting bin `F-01-0001` (the
     existing Sales-Floor inbound path).

### Data flow

```
Item Receipt created (existing)
        │
        ▼
Candidate query (SuiteQL: floor on-hand + preferred level per received item)
        │  qualifying items + quantities
        ▼
Create Transfer Order  (POST record/v1/transferOrder)   ← source = PO location, dest = Sales Floor
        │
        ▼
Bin-guided pick (scan from received bins)               ← shared pick engine
        │
        ▼
Item Fulfillment  (!transform/itemFulfillment)          ← ship from source
        │
        ▼
Item Receipt      (!transform/itemReceipt → F-01-0001)  ← put to floor, no extra scan
        │
        ▼
Pull summary (TO #, moved items, "no level set" notice)
```

Three NetSuite writes (create TO, fulfill, receive); one physical scan pass.

## Error Handling

- Each NetSuite write is guarded against double-submit (same `submitting` guard
  pattern as the existing modules) and surfaces NetSuite's own status + message
  on failure rather than a bare HTTP code.
- A failure after the TO is created leaves the TO in place. The worker can
  resume it from the standard Transfer Orders module (outbound to fulfill,
  inbound to receive), so no work is lost and no orphaned half-state is hidden.
- If the candidate query fails, the button shows an error and does not create a
  TO; the receipt itself is already safely committed.
- Activity logging mirrors the existing modules: a `sales-floor-pull-created`
  success entry (TO #, source → Sales Floor, item list) and a
  `sales-floor-pull-failed` entry on error.

## Testing

- **Candidate rules:** unit-test the candidate selector against fixtures — floor
  qty > 0 (skip), qty 0 + level (include, capped at received), qty 0 + no level
  (notify), PO received to Sales Floor (empty list).
- **Quantity cap:** received 3, preferred level 6 → TO line = 3.
- **Pick plan:** received items map to the bins they were received into.
- **End-to-end (manual, sandbox):** receive a PO into a back location for an
  item with 0 on the floor and a set level → run the pull → confirm a TO,
  fulfillment, and receipt exist and the item shows on-hand at Sales Floor in
  `F-01-0001`.

## Open Verification (must resolve first in implementation)

The quantity rule depends on reading each item's **per-location** preferred
stock level (at Sales Floor) via SuiteQL. NetSuite stores this on the item's
location-configuration sublist; the exact SuiteQL table/column exposing it in
this account must be confirmed with a probe query before building the candidate
selector. Candidate sources to test include the item location configuration
table and related per-location replenishment fields.

**Fallback if per-location level is not queryable:** treat every qualifying
item as "no level set → notify." This preserves the entire workflow (the worker
still gets the button, the notice, and a manual path) but makes the notice
longer until the correct query is identified. Do not silently substitute the
company-level preferred stock level for the per-location one.

## Constants / References

- Sales Floor location id: `1` (per `LOCATIONS` in `ItemReceipts.jsx`).
- Sales Floor bin: `F-01-0001` (per `SALES_FLOOR_BIN` in `TransferOrders.jsx`).
- Generic record proxy: `api/record.js`.
- Existing TO transforms: `src/modules/TransferOrders.jsx` (`handleSubmit`).
- Pick plan algorithm: `buildPickPlan` in `src/modules/TransferOrders.jsx`.
