# Bin Lookup — Design

**Date:** 2026-08-27
**Status:** Approved, ready for implementation plan

## Problem

Employees can scan an item and see which bins hold it (Item Lookup). They cannot do
the reverse: stand at a bin, scan it, and see what is supposed to be in it. Today the
only way to see a bin's contents is to start a Bin Transfer, which is a write-path
module and the wrong tool for a read-only question.

## Goal

Scan a bin barcode, see everything in that bin. Read-only. No NetSuite writes.

## User Flow

Two phases, mirroring `BinTransfer`.

### Phase 1 — Pick location

Bin numbers are only unique per location, so the employee picks a location before
scanning. Locations load with:

```sql
SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name
```

The selection persists to `localStorage` through the existing `saveSession` /
`loadSession` helpers in `src/shared.jsx`. A returning employee lands directly on the
scan screen; the header carries a chip showing the active location that returns them
to the picker.

### Phase 2 — Scan bin

A `ScanInput` sits at the top of the screen and holds focus. Scanning a new bin
replaces the results in place — there is no "switch bin" button.

## Results Layout

- **Stat strip** — bin number (mono), location name, `247 SKUs · 1,830 units`.
- **Class groups** — one collapsible section per item class, sorted by class name.
  Items with no class collect into an "Uncategorized" group pinned last. Each group
  header shows its class name plus its own SKU and unit counts.
- **Auto-expand** — bins of 25 SKUs or fewer start fully expanded, so a normal bin
  reads as a plain list with no tapping. Above 25, all groups start collapsed, so a
  Sales Floor catch-all bin renders as a short menu of classes.
- **Item rows** — SKU in mono, item name beneath, qty on hand right-aligned, with
  `(n avail)` in muted text only when available differs from on hand.
- **Item detail** — tapping a row opens the existing `ItemDetailDrawer` from
  `src/components/ItemDetail.jsx`, passing the scan input ref as `refocusRef` so the
  scanner refocuses on close.

## Architecture

New frontend module `src/modules/BinLookup.jsx`, registered as `"bin-lookup"` in
`src/App.jsx` and surfaced as a utility bar directly under Item Lookup on
`src/Home.jsx` (teal `#14b8a6`, icon `▤`, subtitle "Scan a bin to see what's in it").

The module queries from the client, consistent with every other lookup module in this
app. No new API route.

### Two network calls per scan

**1. Resolve the bin** — `GET /api/bins/validate?locationId=<id>&binNumber=<scan>`

This endpoint already exists and is tested. It returns
`{ valid, binId, binNumber }` with NetSuite's canonical casing, and it keeps
`resolveBinAtLocation` in `api/_bins.js` as the single source of truth for bin
resolution rather than adding a fourth copy of bin-resolution SQL to the frontend.

**2. Load contents** — `suiteqlAll`, not `suiteql`

```sql
SELECT ib.item AS item_id,
       item.itemid AS sku,
       item.displayname AS item_name,
       BUILTIN.DF(item.class) AS class_name,
       ib.quantityonhand AS qty_on_hand,
       ib.quantityavailable AS qty_available
FROM inventorybalance ib
JOIN item ON ib.item = item.id
WHERE ib.binnumber = <binId>
  AND ib.location = <locationId>
  AND ib.quantityonhand > 0
ORDER BY BUILTIN.DF(item.class), item.itemid
```

`suiteqlAll` is required: catch-all Sales Floor bins hold thousands of SKUs and
`suiteql`'s 1000-row default would silently truncate them. Its `onProgress` callback
drives a "Loaded 2,000 items…" line so a large bin does not appear frozen.

Because call 1 returns the internal ID, this filters on `ib.binnumber = <binId>`
numerically rather than `BUILTIN.DF(ib.binnumber) = '<string>'` as `BinTransfer` does.
No string matching, no cross-location ambiguity.

## Outcomes and Error Handling

Resolving the bin separately from loading its contents is what makes these three
outcomes distinguishable. `BinTransfer` currently conflates the first two into a
single "Bin is empty or not found at this location" message.

| Outcome | Feedback |
|---|---|
| `valid: false` | `beepWarn`, red flash, "Bin **F-01-0001** doesn't exist at Sales Floor." |
| Valid, zero rows | `beepOk`, neutral card, "Bin **F-01-0001** is empty." Stat strip reads `0 SKUs · 0 units`. This is a correct answer, not an error. |
| Valid, has rows | `beepBin`, grouped results, activity log entry. |

A thrown error from either call clears the results and renders the standard `S.err`
card. Stale contents are never left sitting under a fresh bin's header.

## Activity Logging

Each successful lookup writes
`logActivity({ module: "bin-lookup", action: "bin-lookup", status: "success", details: "F-01-0001 @ Sales Floor — 247 SKUs, 1,830 units", sourceDocument: "F-01-0001" })`,
wrapped in try/catch the way `ItemLookup` does.

`src/modules/ActivityLog.jsx` needs `bin-lookup` added to `MODULE_OPTIONS`,
`ACTION_OPTIONS`, and `ACTION_LABELS`, mirroring the existing `item-lookup` entries.

## Testing

Vitest, TDD. Component tests carry the `// @vitest-environment jsdom` pragma used by
the existing component tests.

**Pure functions** — exported as named exports from `BinLookup.jsx` so the interesting
logic tests without a DOM:

- `groupByClass(rows)` — groups ordered by class name; "Uncategorized" pinned last
  regardless of alphabetical position; per-group SKU and unit totals correct; null,
  empty, and whitespace-only class names all land in the Uncategorized bucket.
- `shouldAutoExpand(skuCount)` — tested at the 25/26 boundary.

**Component tests** — cover the wiring that is easy to get wrong:

- An invalid bin renders the "doesn't exist at" message and never fires the contents
  query.
- A valid bin returning zero rows renders the empty state, not an error.

## Out of Scope

Deliberately excluded:

- **Recent-bin history.** By the time it would be useful the employee has walked to a
  different bin. Re-scanning is the natural action.
- **Sort and filter controls.** Class grouping already provides the narrowing; a
  filter box on top of it is redundant on a 5.5" screen.
- **Verify / count mode.** Scanning items to check them off against expected
  quantities is Inventory Count, which already exists.
