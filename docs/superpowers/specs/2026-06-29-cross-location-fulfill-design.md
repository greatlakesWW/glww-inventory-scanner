# Cross-Location Fulfill — Design Spec

**Date:** 2026-06-29
**Module:** SO Picking (`src/pick-so/`) + SO fulfillment RESTlet (`netsuite/fulfillSalesOrder.js`)
**Status:** Approved design, pending implementation plan

## Summary

Some Shopify orders need more of a SKU than any single NetSuite location holds.
Example: order 26334, item `103554-253-3XLREG`, qty 2 — one unit in **Backroom**,
one on the **Sales Floor**. The Shopify→NetSuite integration stamps the whole
line at a default location ("Warehouse"), so the standard pick flow can't source
it and the order is fulfilled by hand.

This feature scripts the manual workaround already proven in this account:
create **one Item Fulfillment per location, each with the IF line's `location`
overridden** to the location actually holding the stock, the calls summing to
the ordered quantity. The order goes Partially Fulfilled after the first IF and
fully shipped after the last.

Detection is automatic at scan time; handling is a dedicated, self-contained
tool. The everyday wave-pick flow is left untouched.

## Background — why this is the chosen path

In NetSuite a single Sales Order line is committed to **one** location. A line
of qty 2 at "Warehouse" cannot be shipped partly from Backroom and partly from
Sales Floor as a single fulfillment.

Two NetSuite-valid ways to resolve this were considered:

1. **Split the SO line** into one sub-line per location, then let the existing
   multi-location wave-pick flow fulfill each. Rejected for v1: it mutates the
   Sales Order, with possible Shopify-sync side effects, and is not the path the
   team currently trusts.
2. **Location-override fulfillment** — create an Item Fulfillment and change the
   location on the IF line, shipping from a location other than the line's
   committed one. This is what the team does manually today and confirms works
   in this account's NetSuite UI. **Chosen.** It never touches the Sales Order.

## Goals

- Surface split-inventory orders **automatically, at scan time**, before the
  picker walks to an empty shelf.
- Fulfill such an order across locations from the handheld, without leaving the
  app for NetSuite.
- Leave the proven wave-pick flow completely unchanged.
- Use availability that nets out other commitments, so a picker is never sent
  after a unit reserved for another order.

## Non-Goals

- **Auto-detecting mid-wave** (folding a cross-location pick into a running
  wave). The wave engine is single-location by design; retrofitting it is out of
  scope. May graduate later.
- **Fixing the upstream Shopify→NetSuite location stamping.** That is a
  Shopify-NetSuite Sync concern, not a picking-app change.
- **Splitting the Sales Order line.** This flow never edits the SO.
- Cross-location fulfillment of *assemblies/kits* with component-location
  nuance — v1 targets inventory-part lines (`InvtPart`), matching the existing
  flow's `itemtype` filter.

## User Flow

1. Picker scans a stack of packing slips on the plan screen (existing flow).
   Each scan resolves via `POST /api/sales-orders/resolve`.
2. For each resolved order the app now also checks **per-location availability**
   of each line's item. An order whose line is short at its committed location
   but coverable across other locations is tagged `needsSplit`.
3. The plan screen renders flagged orders as a **distinct pile** with a
   **"⚠ Split across locations →"** affordance, separate from the normal
   per-location cards. Fully-sourceable orders are unaffected and pick as today.
4. Picker taps a flagged order → the **split-fulfill tool** opens. It shows the
   order header, the short SKU(s), and where the stock actually lives
   ("Backroom: 1 · Sales Floor: 1"). The app proposes a split by availability;
   the picker can adjust it.
5. The tool guides the picker location-by-location, scanning units out of the
   real bins (reusing the existing bin-scan UI).
6. On completion the app calls the fulfillment RESTlet **once per location,
   sequentially**. First call → SO Partially Fulfilled; last call → fully
   shipped. A summary shows each IF created and the location it shipped from.

## Architecture

### Detection — `api/sales-orders/resolve.js`

After the existing per-location ordered-qty roll-up, add an availability pass:

- For each resolved order's inventory lines, read available qty of the line's
  item **at its committed location** and **across all locations**.
- Tag the order `needsSplit: true` when, for at least one line,
  `availableAtCommittedLocation < qtyRemaining` **and**
  `availableAcrossAllLocations >= qtyRemaining`.
- Attach a `splitPlan` payload per flagged order: per short line, the item, the
  remaining qty, and a per-location availability breakdown
  (`[{ locationId, locationName, available }]`).
- Orders short *everywhere* (true stockout) are **not** tagged `needsSplit` —
  they remain a genuine shortage for normal handling, not a split candidate.

Availability source: `inventorybalance.quantityavailable` aggregated per
`(item, location)`. The existing bin query in `api/sales-orders/[id].js`
already reads `inventorybalance` per location — extend that pattern. See
**Open Verification** for the `quantityavailable` column probe; fall back to
`quantityonhand` if it is not exposed in this account.

### Split-fulfill tool — `src/pick-so/`

A new screen (e.g. `SplitFulfillScreen.jsx`) reached from the plan screen for a
single flagged order. Responsibilities:

- Render the order, the short line(s), and the per-location availability from
  `splitPlan`.
- Let the picker confirm/adjust the per-location quantity split (default
  proposed by availability, oldest-/most-available-first; total locked to
  `qtyRemaining`).
- Guide a bin-scan at each chosen location, reusing the existing bin-scan UI
  component used by the wave-pick screen. Each scan records
  `{ locationId, binId, qty }`.
- On completion, drive the per-location fulfillment calls and render a summary.

This tool is **outside** the wave/lock machinery — it operates on one order at a
time and does not create a `session:wave:*` record. (See **Concurrency** for the
lock interaction.)

### Fulfillment — `netsuite/fulfillSalesOrder.js` + a thin API route

The RESTlet gains one capability: an optional **`locationId` per line**. When
present, after selecting the matching item sublist line and before assigning
bins, it sets the line's `location` field to `locationId`, then removes the
auto-allocation and adds the supplied bins (which must belong to that location).
When absent, behavior is unchanged (back-compat with the wave flow).

Request body extension:

```jsonc
{
  "salesOrderId": "12345",
  "setShipped": false,
  "lines": [
    {
      "itemId": "7566",
      "locationId": "2",                 // NEW — override IF line location
      "bins": [{ "binId": "2995", "quantity": 1 }]
    }
  ]
}
```

The app fires this **once per location**, **sequentially**:

- Call 1: `{ locationId: Backroom, bins: [...], setShipped: false }` → IF #1,
  SO → Partially Fulfilled.
- Call 2 (after #1 returns): `{ locationId: Sales Floor, bins: [...],
  setShipped: true }` → IF #2, SO → fully shipped.

`setShipped: true` only on the call that completes the order. Sequential calls
sidestep the RCRD_HAS_BEEN_CHANGED contention the wave flow already handles; the
existing contention retry helper still applies as a safety net.

A new API route (e.g. `POST /api/sales-orders/:id/split-fulfill`) orchestrates
the per-location calls server-side so the handheld makes one request and the
OAuth/RESTlet plumbing stays on the server (mirrors `so-sessions/:id/fulfill`).

### Data flow

```
Scan packing slips → /resolve
        │  per order: per-location ordered qty + per-location AVAILABILITY
        ▼
needsSplit? ── no ──► normal per-location cards → existing wave pick (unchanged)
        │ yes
        ▼
"⚠ Split across locations" pile → Split-Fulfill tool
        │  picker confirms split, scans bins per location
        ▼
POST /api/sales-orders/:id/split-fulfill
        │  sequential, one per location
        ├─► fulfillSalesOrder (locationId=Backroom)   → IF #1 (partial)
        └─► fulfillSalesOrder (locationId=SalesFloor) → IF #2 (shipped)
        ▼
Summary: IFs created + location each shipped from
```

## Concurrency

- The split-fulfill tool does **not** take a `session:so-lock:{soId}:{loc}` wave
  lock. Two pickers split-fulfilling the same order is unlikely (it is the
  exception path), but to be safe the orchestrating route should re-check
  remaining qty per location immediately before each RESTlet call and abort a
  call whose location no longer has the stock (a sibling action consumed it),
  returning a clear "already taken" result for that location rather than erroring
  opaquely.
- Per-location IF calls are sequential, so the two IFs against one SO never
  contend with each other.

## Error Handling

- Each per-location call's result is reported individually: location, IF id (on
  success), or NetSuite's own message (on failure).
- **Partial success is real and must be surfaced.** If IF #1 succeeds and IF #2
  fails, the SO is legitimately Partially Fulfilled — the summary must say so
  clearly (what shipped, what didn't, from where) so the picker/admin can finish
  the remaining location rather than assume total success or total failure.
- A failed `quantityavailable`/detection pass must not block normal picking:
  resolve should still return orders (untagged) if the availability sub-query
  fails, logging the degradation. Better to miss a split flag than to break the
  scan screen.
- Activity logging mirrors existing modules: a `cross-location-fulfill` success
  entry (SO #, per-location IFs) and a `cross-location-fulfill-failed` entry on
  error.

## Testing

- **Detection selector (unit):** fixtures for — short at committed loc + covered
  elsewhere (flag), fully sourceable at committed loc (no flag), short everywhere
  / true stockout (no flag), multi-line order with one short line (flag).
- **Split proposal (unit):** ordered 2, avail Backroom 1 + Sales Floor 1 →
  proposes 1+1; ordered 2, avail Backroom 3 → not a split candidate (sourceable);
  picker override respected, total locked to qtyRemaining.
- **RESTlet location override (unit/integration):** body with `locationId` sets
  the IF line location and assigns that location's bins; body without it is
  byte-for-byte the old behavior.
- **End-to-end (manual, sandbox):** an order short at its committed location with
  1 unit each at two other locations → run the tool → confirm two linked IFs
  exist, each shipping from the expected location, and the SO is fully shipped.
- **Partial-failure path (manual, sandbox):** force IF #2 to fail → SO is
  Partially Fulfilled and the summary states exactly what remains.

## Open Verification (must resolve first in implementation)

1. **`inventorybalance.quantityavailable` queryable** in this account's SuiteQL
   SEARCH channel. Probe before building the detection selector. **Fallback:**
   `quantityonhand` (accept rare over-optimistic flags). Do not silently use a
   company-level number — availability must be per `(item, location)`.
2. **RESTlet `location` override ships from a non-committed location.** Manual
   "B" in the NetSuite UI confirms this is allowed in-account; verify the
   *scripted* `record.transform` path can set the line `location` and save.
   Sandbox probe on a real SO.
3. **SO→IF transform produces the line when the committed location has 0
   available**, so it can be re-located. If the transform drops the line, the
   override must instead set location on a line the transform still surfaces —
   confirm the transform's behavior with 0 committed-location availability.

If any probe fails, stop and revisit before building — the manual path working
in the UI is strong but not a guarantee the scripted transform behaves
identically.

## v2 Follow-ups (deferred from v1 code review)

These were identified in the v1 final code review and intentionally deferred —
v1 ships without them. None block the single-picker exception flow.

1. **Per-location availability re-check in the route** (Important). `split-fulfill.js`
   fires per-location RESTlet calls without re-reading availability immediately
   before each call. Per §Concurrency it should re-check and abort a location
   whose stock a sibling action consumed, returning a clear "already taken"
   result. Low probability on a single-picker exception path, but specified.
2. **Partial-SO (status D) split detection** (Minor/latent). The detection query
   in `resolve.js` uses `SUM(ABS(tl.quantity))` = ordered qty, correct only for
   Pending (status B) SOs. For Partially Fulfilled SOs reuse
   `loadSOPerLocationRemaining` (`api/_so-fulfillment.js`) to get remaining qty.
3. **Activity logging** (Minor). Add `cross-location-fulfill` /
   `cross-location-fulfill-failed` entries (mirroring the wave path's KV shortage
   log) to the orchestration route.

## Constants / References

- Resolve endpoint: `api/sales-orders/resolve.js`.
- Per-location lines + bin availability: `api/sales-orders/[id].js`,
  `api/_so-fulfillment.js` (`loadSORemainingAtLocation`,
  `loadSOPerLocationRemaining`).
- Inventory availability source: `inventorybalance` (`quantityavailable` /
  `quantityonhand`).
- Fulfillment RESTlet: `netsuite/fulfillSalesOrder.js`.
- Existing wave fulfill orchestration (pattern to mirror):
  `api/so-sessions/[id]/fulfill.js`.
- SO pick UI + bin-scan to reuse: `src/pick-so/` (`PlanScreen.jsx`,
  `WavePickScreen.jsx`).
- Sales Floor location id: `1` (per the Sales Floor Pull spec).
