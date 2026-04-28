# Pick Sales Orders

A barcode-scanner-driven workflow for pickers to pull stock for **multiple Shopify/NetSuite Sales Orders at once**, then create the corresponding Item Fulfillments in NetSuite.

The defining choices:

- **Wave picking** — many SOs are picked simultaneously as one aggregated list (one row per SKU, summed across SOs). Allocation back to individual SOs happens at fulfill time, not pick time.
- **Multi-location aware** — a single SO can have lines at multiple warehouses. The picker scans the order numbers, the app groups them by source location, and the picker walks one location at a time.
- **Multi-picker safe** — the backend tracks SO locks in Vercel KV so two pickers can't accidentally wave the same order. There's a controlled override path for stale locks.
- **FIFO allocation, oldest SO first** — at fulfill time, scanned units are doled out to SOs in `trandate ASC` order, line by line.

---

## Code shape

```
src/pick-so/
  PickSalesOrders.jsx         — phase router (plan → location → list → pick)
  PlanScreen.jsx              — default entry; scan order #s, group by location
  LocationPickerSO.jsx        — alt entry; pick a location to browse
  SOListScreen.jsx            — list/select Pending Fulfillment SOs at one location
  WavePickScreen.jsx          — bin-then-item scanning across the wave
  useWavePickSession.js       — hook wrapping the wave session API

api/
  sales-orders.js             — GET list of Pending SOs at a location (decorated with locks)
  sales-orders/[id].js        — GET one SO's lines + bin availability at a location
  sales-orders/resolve.js     — POST batch-resolve scan keys → SOs grouped per location
  so-sessions.js              — POST create/resume a wave session (handles lock conflicts)
  so-sessions/[id].js         — GET state, PATCH event (scan/add_so/remove_so/mark_unavailable/…)
  so-sessions/[id]/fulfill.js — POST allocate scans → SOs and call the RESTlet, FIFO oldest-first
  _kv.js                      — KV key formats + helpers; 48h TTL; SO lock keys

netsuite/
  fulfillSalesOrder.js        — SuiteScript RESTlet that does record.transform(SO → IF)
```

---

## End-to-end flow

### 1. Plan (`PlanScreen.jsx`)

Default landing screen. The picker types their name once (cached in `glww_picker_name` localStorage) and scans a stack of order numbers in any order.

Each scan posts to `POST /api/sales-orders/resolve`. That endpoint matches the scanned key against **both** `transaction.tranid` (NetSuite SO#) **and** `custbody_fa_channel_order` (Shopify order #), and returns a per-location breakdown of unfulfilled inventory lines.

Resolved SOs are grouped by source location and rendered as a card per location. Plan state is mirrored to localStorage at `glww_so_plan_v1` so a refresh mid-plan doesn't lose progress.

When the picker taps "Pick →" on a location card, control jumps to the wave-pick screen for that location's SO subset. Completed locations get stamped ✓ via a `completionSignal` counter — see "Gotchas."

### 2. Wave session creation (`api/so-sessions.js`)

`PickSalesOrders.handlePickAtLocation` POSTs `{ pickerName, locationId, soIds }`. The backend:

1. Reads the lock key `session:so-lock:{soId}` for each SO.
2. **Conflict detection:** any SO locked by a different picker → returns 409 with a `conflicts[]` payload that includes `hasScans: boolean` per conflict.
3. **Force-override path** (`force: true`): only releases locks where `hasScans === false`. Locks with real scan events are protected — even the override can't clobber actual work.
4. **Resume path:** if the same picker already owns a wave with overlapping SOs, the new SOs are merged into that wave instead of creating a new one.
5. Otherwise creates `session:wave:{sessionId}` JSON and writes a `session:so-lock:{soId} = sessionId` for each SO. 48h TTL, refreshed on every write.

### 3. Wave picking (`WavePickScreen.jsx`)

For each SO in the wave, the screen calls `GET /api/sales-orders/:id?location={id}` to fetch unfulfilled lines plus bin availability. It then aggregates everything into a single per-SKU pick list:

- `needByItemId` — total qty needed across all SOs in the wave
- `metaByItemId` — SKU/UPC/description/bins for matching
- `binPlan` — which items live in which bin

The picker **scans a bin, then scans items**. Each item scan calls `recordScan()` from `useWavePickSession.js`, which PATCHes the session with a `scan` event carrying a fresh `clientEventId`. The list re-sorts on every scan: items in the current bin float to the top; fully-picked or unavailable rows sink.

UX details that matter:

- **Manual +1** (tap a row instead of scanning) is gated behind **three** native `confirm()` dialogs. Friction is intentional — pickers should reach for the scanner unless the UPC is missing or the scanner is broken.
- **Mark Unavailable** sends a `mark_unavailable` event. The item disappears from the "needs picking" list and the wave can complete despite the shortage.
- **Manage Wave** modal lets the picker remove an SO mid-wave — scans are kept, the locks for the dropped SO are released immediately, and on fulfill the previously-allocated scans flow to the remaining SOs FIFO.

### 4. Complete (`api/so-sessions/[id]/fulfill.js`)

Tap "Complete" → `POST /api/so-sessions/:id/fulfill`. The endpoint:

1. **Builds a per-item FIFO scan queue** from `events.filter(e => e.type === 'scan')`. Order is preserved.
2. **Loads SO headers** via SuiteQL ordered by `trandate ASC, id ASC`.
3. **Loads SO lines** at the wave's source location only (lines at other locations are intentionally ignored).
4. **Allocates pool → SOs oldest-first.** For each SO line, drains as much from the FIFO queue as needed. Anything left over is a shortage on that line.
5. **Splits shortages** into two buckets: `unavailableShort` (items the picker tapped Unavailable) and `pendingShort` (items the picker just didn't reach).
6. **Calls the SO fulfillment RESTlet** once per SO with non-empty allocation. `setShipped: true` only when `pendingShort.length === 0` — i.e. everything unpicked was explicitly flagged unavailable. Otherwise the IF stays in "Picked" status for someone to finalize later.
7. **Logs unavailable items** to KV under `shortage:{ts}:{soId}` with 30-day TTL for an admin follow-up workflow (no UI for this yet).
8. **Cleans up:** if any SO succeeded, deletes the wave session (which also drops every SO lock). If none succeeded but some errored gracefully, persists the wave as `fulfilled_partial` for retry.

### 5. NetSuite RESTlet (`netsuite/fulfillSalesOrder.js`)

Standalone SuiteScript 2.1 RESTlet. Uses `record.transform(SALES_ORDER → ITEM_FULFILLMENT, isDynamic: true)` then walks every line in the IF sublist:

- For our items: sets `itemreceive: true`, sets quantity, **deletes NS's auto-allocated inventoryassignment subrecord rows**, then adds our own `binnumber + quantity` rows.
- For other lines: sets `itemreceive: false` so they remain unfulfilled.

The dynamic record API + manual subrecord rewrite is required because the REST `!transform/itemFulfillment` endpoint pre-populates inventoryDetail and then refuses to accept changes — see the file's header comment.

---

## Storage map

| Storage | Key | Purpose | TTL |
|---|---|---|---|
| Vercel KV | `session:wave:{sessionId}` | Full wave session JSON (events, soIds, picker, status) | 48h, refreshed each write |
| Vercel KV | `session:so-lock:{soId}` | Which session currently owns this SO | 48h, refreshed each write |
| Vercel KV | `shortage:{ts}:{soId}` | Picker-marked-unavailable items for admin follow-up | 30 days |
| localStorage | `glww_so_plan_v1` | Plan state (scanned, resolved, completedLocations) | indefinite |
| localStorage | `glww_picker_name` | Last entered picker name | indefinite |
| localStorage | `glww_device_id` | Random device identifier sent with every PATCH | indefinite |

---

## Idempotency / safety

- Every PATCH carries a fresh `clientEventId`. The backend short-circuits with the existing session if it sees the same id again, so retries after a network blip never double-apply scans.
- `pickerName` is checked on every PATCH (except `take_over`). If it doesn't match the session's current picker, the request is rejected with `session_taken_over` — protects against a stale tab continuing to write after a force-override.

---

## Gotchas — read these before changing anything

### NetSuite / SuiteQL quirks

1. **`transactionline.quantityfulfilled` is NOT exposed to SuiteQL's SEARCH channel** in this account. The list endpoint and detail endpoint both work around this by **only listing Pending Fulfillment (`status = 'B'`) SOs**, where every line is unfulfilled, and treating `qty_remaining = ABS(qty_ordered)`. **Adding support for Partially Fulfilled SOs requires switching to the REST Record API** — see comments at the top of `api/sales-orders/[id].js` and `api/so-sessions/[id]/fulfill.js`.

2. **SO `transactionline.quantity` is stored NEGATIVE.** Every place it's read uses `ABS()`. If you write a new query, you'll forget this once and confuse yourself for an hour.

3. **GROUP BY + aggregates + `BUILTIN.DF()` is rejected** by the SEARCH channel with "Invalid or unsupported search". The list endpoint splits into a header query + a separate aggregate query for that reason. Don't try to combine them.

4. **The custom RESTlet exists for a real reason.** REST `!transform/itemFulfillment` pre-populates `inventoryDetail` and then errors on any change ("total inventory detail quantity must be N" / "static sublist"). The dynamic-record SuiteScript path can delete the auto-allocations before adding ours. Don't switch back to REST without re-discovering this.

5. **`NS_RESTLET_FULFILL_SO_URL` is deliberately separate** from the TO RESTlet env var. There's a fail-fast check in `api/so-sessions/[id]/fulfill.js`. Don't add a fallback — routing SO traffic through the TO deployment would be a silent data corruption.

### Concurrency

6. **The KV "lock" is best-effort, not a distributed lock.** Between `getSOLock()` returning empty and `writeWaveSession()` writing the new lock, another request could write theirs. Last writer wins. In practice the picker UX (one wave at a time per person) makes this rare, but don't treat it as airtight.

7. **The `hasScans` escape hatch can race.** If picker A's session has zero scans at the moment picker B's `force: true` request lands, the contested SO is removed from A's wave. If A's PATCH for a real scan event arrives milliseconds later, it succeeds (their session still exists) but the scan is recorded against an SO they no longer own — those scans become orphaned at fulfill time. Worth knowing if you ever see a "where did my scans go?" report.

8. **Wave fulfillment is partially atomic.** If *any* SO succeeds, the entire wave session is deleted and all SO locks released. Per-SO failures are reported but don't roll back the successes. If *all* errored, the session is preserved as-is for retry. If some errored gracefully (e.g. `skipped_no_allocation`) but none succeeded, the wave is marked `fulfilled_partial`.

### UI / UX

9. **`completionSignal` uses a counter to force re-fire.** When a wave finishes, `PickSalesOrders.jsx` bumps `{ locationId, n }` so PlanScreen's effect re-runs even when the same locationId completes twice. Don't simplify this to just `locationId` — same-value React state updates would no-op.

10. **`useScanRefocus` will steal focus from text inputs.** `SOListScreen` and `PlanScreen` both track a `nameFocused` state and gate the refocus hook on it — otherwise typing the picker's name fights the auto-refocus.

11. **Manual +1 has three confirms on purpose** (`WavePickScreen.jsx`, `handleManualAdd`). Don't "improve" it down to one — the friction is the feature.

12. **Detail fetch is keyed on `session.soIds.join(",")`** in `WavePickScreen.jsx` and only fetches `missing` SOs. If you remove an SO and add the same one back later, the cached detail won't refetch — currently no-op since there's no add-SO UI, but if you wire one up, also clear `detailBySO[sid]` on remove (the screen does this on remove; a future re-add path needs the same care).

### Backend completeness

13. **`add_so` and `take_over` event types exist in the API but have no UI.** See `api/so-sessions/[id].js`. The hook `useWavePickSession.js` exposes `addSO` but it's never called.

14. **The shortage log has no UI.** Items marked unavailable are dutifully written to `shortage:{ts}:{soId}` for 30 days, but there's no admin view that reads them. The plumbing's there if/when someone builds the screen.

15. **`PlanScreen.handleScan` calls `/resolve` one key at a time** even though the endpoint takes `keys[]`. Each scan = 3 SuiteQL round-trips (header + lines-by-loc + location-name). Bulk scanning a stack of orders is slower than it could be — batching the keys client-side would be a worthwhile optimization.

16. **Cross-location SOs stay Partially Fulfilled.** A wave only fulfills lines at the wave's source location. Lines at other locations are simply ignored, leaving the SO partially fulfilled. The PlanScreen UX expects this — same SO appears under multiple location cards, picker walks each in turn — but if a future change introduces a single-location flow without the plan layer, it's easy to forget that "the SO didn't ship fully" is the *intended* outcome here.
