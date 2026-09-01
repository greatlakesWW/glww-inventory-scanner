# Receiving Scan Correction — Design Spec

**Date:** 2026-09-01
**Module:** Item Receipts (`src/modules/ItemReceipts.jsx`)
**Status:** Approved design, pending implementation plan

## Summary

A receiver who scans an item twice has no way to take the unit back. Item Receipts
only ever increments: `handleItemScan` adds `+1` to `receivedItems` and `binItems`
and keeps no scan history, and no line offers a quantity control. The over-receipt
is caught only at submit time, by NetSuite, which rejects the Item Receipt outright.
The receiver is then stuck holding a session they can neither submit nor correct —
the only escape is discarding every scan and starting the PO over.

This adds a **lower-only** quantity control to the receive screen. Tapping a line's
quantity readout expands an inline panel listing the bins that line was scanned
into; tapping a bin removes one unit from it. Everything happens in session state
before submit. Nothing here talks to NetSuite.

## Goals

- Remove a mis-scanned unit without discarding the session.
- Work when the mistake is noticed at the end and the receiver does not know which
  scan was the duplicate — the over-receipt badge already names the line.
- Keep bin attribution honest: a removed unit comes off a specific bin, chosen by
  the receiver when it is ambiguous.
- Preserve the existing session shape so an in-progress session on a handheld
  resumes intact across the deploy that ships this.

## Non-Goals

- **Raising** a quantity. Every unit received must be physically scanned, so the
  panel offers no `+`. A receiver who removed one too many rescans the item.
- Undoing or amending an Item Receipt already created in NetSuite. Once submitted,
  correction is a NetSuite-side task.
- Editing quantities received on a **prior** Item Receipt against the same PO.
  Those are already committed; only this session's scans are editable.
- Fixing the `ItemDetailDrawer` "NetSuite 500" seen when tapping a PO line. Real
  bug, tracked separately, out of scope here.
- A blocking client-side guard against over-receipt at submit. NetSuite's rejection
  stays the backstop; this spec gives the receiver a way to act on it.

## User Flow

1. Receiver scans items into bins as they do today. A duplicate scan pushes a line
   over its ordered quantity; the existing purple `OverBadge` and the "N items over
   expected quantity" banner already flag it.
2. Receiver taps the `{rcvd}/{ordered}` readout on that line.
3. An adjust panel expands beneath the row, listing every bin that line was scanned
   into this session, each as a tappable `− BIN-A (3)` row.
4. Receiver taps a bin. One unit comes off that bin and off the line total. Counts,
   badge, banner, and progress bar update immediately.
5. The panel stays open for a second removal, and collapses automatically when the
   line's session count reaches zero, or when the receiver taps **Done**.
6. Scan focus returns to the item input. Receiving continues.
7. With the count corrected, **Create Receipt** succeeds.

## Interaction Detail

### Tap target

The right-hand quantity readout — currently a plain `<div>` rendering
`{rcvd}/{ordered}` — becomes its own tap target on any line where
`sessionRcvd > 0`. Its `onClick` calls `e.stopPropagation()` so the row's
`openDrawer(line.item_id)` never fires; tapping anywhere else on the row still
opens the detail drawer exactly as it does today.

Lines with `sessionRcvd === 0` render the readout unchanged and untappable. That
covers untouched lines and lines fully received on a prior Item Receipt — neither
has anything this session can take back.

The readout gains a subtle affordance when tappable (a border and a small `⌄`), so
a receiver can tell at a glance which lines can be corrected.

### Adjust panel

One line's panel is open at a time, tracked by a single new state value
`adjustingItemId` (item id, or `null`). Tapping a different line's readout moves the
panel; tapping the open line's readout again closes it, as does the panel's own
**Done** row.

The panel derives its bin rows from `binItems`, filtering keys ending in
`::<item_id>` — the same derivation the row already uses to render its
`BIN-A(3), BIN-B(2)` summary. Each bin renders as a full-width tappable row:
`−  BIN-A  (3)`, with a **Done** row beneath them to dismiss the panel.

This unifies the single-bin and multi-bin cases into one control. With one bin
there is one row to tap, and it still names the bin so the receiver sees where the
unit is coming from. With several bins the choice is explicit. There is no separate
picker modal and no implicit "most recent bin" rule.

Every session scan is guaranteed to carry a real bin: `BinScanner`
(`src/shared.jsx:275`) does not render the item scan input until `currentBin` is
set, so `handleItemScan` can never write a `null::<itemId>` key. The panel therefore
always has at least one bin row to show whenever `sessionRcvd > 0`.

### Removing a unit

Tapping a bin row decrements both maps together:

- `binItems["<bin>::<itemId>"]` minus one; the key is **deleted** at zero, matching
  how `BinTransfer.setItemQty` (`src/modules/BinTransfer.jsx:225`) prunes cleared
  entries. This keeps the emptied bin out of the row's bin summary, out of the
  panel, and out of the receipt payload built by `getItemBinAssignments`.
- `receivedItems[itemId]` minus one; the key is deleted at zero, so the line falls
  back to its untouched appearance and its readout stops being tappable.

Both are floored at zero. A `beepOk` and the existing `ok` flash confirm the
removal, mirroring the feedback a scan gives.

After each removal the panel re-renders from the updated `binItems`, so a bin that
just hit zero disappears from the list. When the last one goes, `adjustingItemId`
resets to `null` and `scanRef.current?.focus()` restores scan focus, following the
`dismissNotOnPO` pattern (`src/modules/ItemReceipts.jsx:219`).

### Interaction with existing screen behaviour

- **Scan refocus.** `useScanRefocus` refocuses the scan input on any click in the
  receive phase. The panel's handlers call `stopPropagation()`, and each removal
  explicitly refocuses afterwards, so the scanner is never left dead.
- **Not-on-PO modal.** While `notOnPO` is set, scanning is blocked. Adjusting is
  blocked the same way: the readout is inert until the modal is dismissed, so the
  receiver deals with one thing at a time.
- **Submitted receipts.** Once `receiptSubmitted` is true the screen has moved to
  the summary phase, which this spec does not touch.

## State and Persistence

No change to the session shape. The only new state is `adjustingItemId`, which is
transient UI and is **not** persisted — a resumed session opens with no panel.

The existing auto-save `useEffect` (`src/modules/ItemReceipts.jsx:114`) already
persists `receivedItems` and `binItems` on every change, so a correction survives a
refresh, a browser kill, or the handheld sleeping, exactly as a scan does.

Because the persisted shape is unchanged, a session already sitting on a handheld
resumes intact after this ships. The stuck 26-scan session that prompted this work
can be corrected in place rather than rescanned.

## Testing

Vitest + React Testing Library, following the saved-session mounting pattern in
`src/modules/ItemReceipts.notOnPO.test.jsx` — seed `localStorage` with a session in
the `receive` phase, click Resume, and assert without any SuiteQL calls. New file:
`src/modules/ItemReceipts.adjustQty.test.jsx`.

| Case | Assertion |
|---|---|
| Single-bin line, tap readout then tap the bin row | Line total drops by one; bin summary count drops by one |
| Decrement a bin to zero | That bin disappears from the row summary and from the panel |
| Multi-bin line | Panel lists both bins with their counts; tapping one decrements only that bin |
| Decrement the last unit on a line | Panel closes, line reverts to untouched styling, readout no longer tappable |
| Line with `sessionRcvd === 0` | Tapping the readout opens nothing |
| Over-scanned line decremented back to ordered | `OverBadge` and the "over expected quantity" banner both clear |
| Tap the readout | Item detail drawer does not open |

Run with `npm test`.
