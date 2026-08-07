# Cross-Location Moves in Bin Transfer — Design Spec

**Date:** 2026-08-07
**Module:** Bin Transfer (`src/modules/BinTransfer.jsx`)
**Status:** Approved design, pending implementation plan

## Summary

Extend the existing Bin Transfer module so a worker can move inventory from a
bin at one location to a bin at a **different** location — e.g. scan a backroom
bin, scan the items to move, then pick the Sales Floor as the destination and
scan the receiving bin. Same-location moves keep posting a NetSuite
**Bin Transfer** exactly as today; cross-location moves post a one-step
**Inventory Transfer** (`inventorytransfer`), so stock leaves the source bin
and lands in the destination bin in a single instant transaction with no
in-transit state.

## Goals

- One flow for all physical moves: the worker scans a source bin and items,
  then chooses where the stock goes — same location or another one.
- Instant inventory accuracy: the move is one NetSuite transaction; nothing
  sits "in transit."
- No new home-screen tile, no duplicated scan/tally UI.

## Non-Goals

- Two-step moves with an in-transit state (Transfer Orders). Those remain the
  Pick Transfer Orders flow.
- Moving from multiple source bins in one submission. One source bin per
  transfer, as today.
- Changing subsidiaries. The transfer stays within subsidiary `2` (both sides
  of the move), matching the hardcoded subsidiary in the current module.

## User Flow

1. **Select location** — unchanged.
2. **Scan source bin** — unchanged; loads bin contents.
3. **Scan items to move** — unchanged; tally with undo and inline qty edit.
4. **Destination step (changed):**
   - A new **"To Location"** selector sits above the destination-bin scan
     input, defaulting to the source location. Tapping it lists the other
     active locations (reuses the location list already loaded in phase 1).
   - The worker scans or types the destination bin. Validation runs against
     the **selected destination location** via the existing `Bin` table query.
   - Rejection rules:
     - Bin not found at the selected destination location → error, stay put.
     - Destination bin equals source bin **and** destination location equals
       source location → "Destination must be different from source." (The
       same bin number at a *different* location is allowed — bin numbers can
       repeat across locations.)
   - Changing the To Location after a bin was scanned clears the scanned
     destination bin, since it was validated against the old location.
5. **Review** — the From/To card shows the location under each bin when the
   locations differ (`B-01-0003 @ Warehouse → F-01-0001 @ Sales Floor`);
   unchanged presentation for same-location moves.
6. **Submit** — see NetSuite Write below. Success screen, activity log, and
   "New Transfer" reset behave as today.

## NetSuite Write

Branch on destination location at submit time; both paths go through the
existing `nsRecord("POST", ...)` helper (`/api/record`).

**Same location** (unchanged):

`POST /record/v1/bintransfer` with the current payload.

**Different location** (new):

`POST /record/v1/inventorytransfer` with:

- `subsidiary`: `{ id: "2" }`
- `location`: source location id
- `transferlocation`: destination location id
- `memo`: `"<srcBin> to <destBin>"` truncated to 40 chars — same format as the
  bin-transfer memo. (Location names were dropped in review: they truncated
  away the destination bin, and the record already carries both locations in
  `location`/`transferlocation`.)
- `inventory.items[]`, one line per item:
  - `item`: `{ id }`
  - `adjustqtyby`: move quantity
  - `inventorydetail.inventoryAssignment.items[]`: single assignment with
    `binNumber` (source bin id), `toBinNumber` (destination bin id), and
    `quantity`

Quantity safety is the same as today: the tally is capped at
`quantityonhand` in the source bin, and NetSuite rejects the transaction
server-side if stock moved between scan and submit.

**Role requirement:** the `Inventory Scanner API` role needs
**Transactions → Transfer Inventory (Full)** for the cross-location path
(added 2026-08-07; without it NetSuite returns `INSUFFICIENT_PERMISSION`).

## Pre-Implementation Verification (must pass before any UI work)

The REST record API is known-good for `bintransfer` in this account, and
transforms are the known RESTlet-only dead end — but plain
`POST /inventorytransfer` with bin-level inventory detail has not been probed.
The implementation plan's first task:

1. `GET /record/v1/metadata-catalog/inventorytransfer` — confirm the record
   and the `inventory` sublist fields (`adjustqtyby`, `inventorydetail`)
   exist.
2. A minimal live `POST` moving 1 unit of a test item between two bins across
   locations, then immediate verification via SuiteQL (and manual reversal if
   needed).

**Fallback if REST rejects the record:** a small RESTlet mirroring
`netsuite/receiveTransferOrder.js`, invoked through the existing auth path.
The frontend branch point stays identical either way.

## State & Session Changes

- New state: `destLocation` (`{ id, name }`), defaulting to `selectedLocation`
  when entering the destination phase.
- Persisted in the `glww_bin_transfer` session blob alongside the existing
  fields; resume restores it.
- Activity log entries gain the location pair in `sourceDocument`
  (`B-01 @ Warehouse → F-01 @ Sales Floor`) when locations differ.

## Error Handling

Unchanged model: submit failure surfaces the NetSuite error, keeps the session
intact, and offers Retry. The only new failure surface is validation of the
destination bin against the selected destination location, which reuses the
existing error/beep/flash pattern.

## Testing

Vitest + Testing Library (jsdom), following `ItemReceipts.notOnPO.test.jsx`:

- Destination-bin validation queries the **selected** destination location,
  not the source location.
- Changing To Location clears a previously scanned destination bin.
- Same bin number allowed when locations differ; rejected when same location.
- Submit builds a `bintransfer` payload when locations match and an
  `inventorytransfer` payload (correct `location`/`transferlocation`,
  `adjustqtyby`, from/to bin ids) when they differ.
- Resume restores `destLocation`.
