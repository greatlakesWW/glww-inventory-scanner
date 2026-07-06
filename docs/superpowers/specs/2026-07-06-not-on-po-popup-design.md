# Not-on-PO Blocking Popup — Item Receipts

**Date:** 2026-07-06
**Status:** Approved
**Module:** `src/modules/ItemReceipts.jsx` (receive phase)

## Problem

During PO receiving, scanning a UPC/SKU that is not on the selected purchase
order gives only a warning beep and a 400ms red flash on the scan input
(`handleItemScan`, ItemReceipts.jsx). A receiver scanning quickly never
notices, keeps scanning, and unknown items pass through the physical process
unflagged (they were never counted, but the receiver believes they were).

## Solution

Add a **blocking modal** to the receive phase, inline in `ItemReceipts.jsx`,
following the existing overlay pattern used by `InventoryCount.jsx`
(fixed-inset dark overlay + centered card).

### Behavior

1. When `findItem(val)` returns `null` in `handleItemScan`:
   - Play the existing warning beep (`beepWarn`).
   - Open the modal, storing the raw scanned value.
2. Modal contents:
   - Warning icon.
   - Title: **"Last Item Scanned is not on PO"**.
   - The scanned barcode value in monospace beneath the title, so the
     receiver can match it against the item in hand.
   - A large **OK** button.
3. While the modal is open, **all further scans are ignored** — an early
   return at the top of `handleItemScan` (and `handleBinScan`) when the
   modal state is set. Nothing is counted until dismissed.
4. Tapping **OK** closes the modal and refocuses the scan input
   (`scanRef.current?.focus()`), so the next trigger pull works immediately.
5. Overlay click does not dismiss (must be deliberate — the point is to
   force acknowledgment). No auto-dismiss timer.

### State

One new piece of state: `notOnPO` — `null` when closed, otherwise the raw
scanned string. Not persisted to the saved session (a page reload clears it;
that is acceptable since the alert is momentary).

### Out of scope

- TransferOrders and other modules with the same silent-failure pattern
  (extract a shared component only if/when requested).
- Any change to counting, over-receipt, bin, or receipt-creation logic.
- NetSuite calls — none involved.

## Error handling

The unknown scan is never added to `receivedItems`/`binItems` (already true
today). The modal is purely a visibility fix.

## Testing

- Component test (vitest): an unknown scan opens the modal and does not
  increment any counts.
- Component test: while the modal is open, further item scans are ignored.
- Component test: OK dismisses the modal and a subsequent valid scan counts.
- Manual check in dev preview with the flow: select PO → scan unknown UPC →
  modal appears → OK → scan valid UPC → counts.
