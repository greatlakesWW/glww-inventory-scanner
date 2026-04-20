# Feature Spec: TO Pick-and-Fulfill

**Target repo:** `greatlakesWW/glww-inventory-scanner`
**Feature name:** Transfer Order Pick & Fulfill (working name: "Pick Mode")
**Purpose:** Pick items listed on an open NetSuite Transfer Order from multiple backroom bins, then auto-generate the Item Fulfillment and Item Receipt to move inventory from the source location into a fixed salesfloor receiving bin and close the TO.
**Status:** Approved for build. Decisions in §6 are locked unless explicitly re-opened.

---

## How to use this document with Claude Code

This spec is designed to be built in 8 sessions (see §8). Each Claude Code session should:

1. Reference this document by path: `docs/FEATURE_SPEC_TO_FULFILLMENT.md`
2. Focus on the specific session from §8 and the sections it cites
3. Treat §6 (Design decisions) as binding — these are resolved, not open
4. Complete the acceptance criteria in §7 that fall within the session's scope before stopping

Example opening prompt for a session:
> Read `docs/FEATURE_SPEC_TO_FULFILLMENT.md`. Build Session 1 per §8: Vercel KV setup and session CRUD endpoints. Implement §4.3, §4.4, §4.5 only. Confirm acceptance criteria under "Pick Screen — session creation" can be satisfied by the endpoints you build. Do not build any UI. Before writing code, review `api/suiteql.js` to match the existing serverless function and auth patterns.

---

## Table of contents

1. [Scope](#1-scope)
2. [User flow](#2-user-flow)
3. [Architecture](#3-architecture)
4. [API contracts](#4-api-contracts)
5. [Frontend component structure](#5-frontend-component-structure)
6. [Design decisions](#6-design-decisions)
7. [Acceptance criteria](#7-acceptance-criteria)
8. [Build order](#8-build-order)
9. [Glossary](#9-glossary)

---

## 1. Scope

### In scope
- New "Pick Mode" flow in the existing PWA, parallel to the existing Count Mode
- TO list screen filtered by source location
- Per-TO pick screen with bin-scan → item-scan loop
- Pause/resume with server-persisted session state (Vercel KV)
- Live-merge multi-device concurrency on a single TO (polling)
- Hard block on over-pick (qty > TO line) and off-TO items
- Backend fulfillment: creates Item Fulfillment + Item Receipt against the TO via NetSuite REST API
- Partial fulfillment supported; TO remains open if not all qty picked

### Out of scope
- Lot/serial tracking (confirmed N/A)
- Substitutions (off-TO items are hard-blocked)
- Mobile push notifications for TO assignment
- Any changes to the existing Count Mode flow
- Audit reporting UI (NetSuite's native reports cover this post-fulfillment)

---

## 2. User flow

1. Home screen gets a new tile: **"Pick Transfer Orders"** (alongside existing "Count Inventory").
2. User taps it → **Source Location** picker (same component used in Count Mode).
3. After selecting source location → **TO List** screen. Shows all open TOs where `location = selected source`. Each row: TO number, destination location, line count, qty total, status badge (Available / In Progress by [name] / Locked by Me).
4. User taps a TO → **Pick Screen**.
   - If no active session for this TO → creates a new session, user becomes owner.
   - If another user owns an active session → shows "In Progress by [name] — last activity [time]. [Take Over] [Back]".
   - If user already owns an active session → resumes where they left off.
5. Pick Screen layout:
   - Header: TO #, source → destination, picker name, "Pause" button, "Complete Pick" button.
   - Current bin: "Scan a bin to begin" OR the currently scanned bin number.
   - Line list: each TO line shows SKU, description, qty ordered, qty picked, qty remaining. Lines with `remaining = 0` collapse / dim.
6. User scans a **bin barcode**:
   - App queries `binonhand` to find which *remaining* TO lines have stock in that bin.
   - Shows expected qty per line in that bin (e.g. "Shirt-Blue-M: 3 expected in this bin").
   - If no remaining lines have stock here → "No TO items in this bin" beep.
7. User scans **items**:
   - Each scan matches an item to a TO line → increments `qty_picked` for that (line, bin) tuple.
   - Hard block if:
     - Item is not on this TO → "Not on this TO" beep + toast
     - Item is on TO but qty already picked = qty ordered → "Line complete" beep + toast
     - Item is on TO but not available in current bin → "Not expected in this bin" warning toast, recorded anyway (see §6.1)
8. User can **Switch Bin** at any time → scans next bin, repeats.
9. User taps **Pause** → session persists to KV, user returns to TO list. Session shows as "In Progress by [name]".
10. User taps **Complete Pick**:
    - Confirmation modal: shows qty picked vs ordered per line, flags any partial lines.
    - On confirm → serverless function creates Item Fulfillment + Item Receipt against the TO, deletes session from KV, returns success.
    - TO drops off the list (if fully fulfilled) or remains with updated remaining qty (if partial).

---

## 3. Architecture

### 3.1 Data flow

```
Munbyn IPDA101 (PWA)
    │
    │  GET /api/transfer-orders?location=X
    │  GET /api/transfer-orders/:id
    │  POST /api/pick-sessions
    │  PATCH /api/pick-sessions/:id (append scan event)
    │  GET /api/pick-sessions/:id (poll for updates)
    │  POST /api/transfer-orders/:id/fulfill
    ▼
Vercel Serverless Functions
    │                           │
    │  SuiteQL + REST writes    │  KV read/write
    ▼                           ▼
NetSuite REST API           Vercel KV (Upstash)
```

### 3.2 New env vars

| Key | Value | Notes |
|---|---|---|
| `KV_REST_API_URL` | *(auto-set by Vercel KV integration)* | Upstash endpoint |
| `KV_REST_API_TOKEN` | *(auto-set)* | Upstash token |
| `NS_SALESFLOOR_BINS_JSON` | `{"17":"123","19":"456"}` | Map of salesfloor location internal ID → receiving bin internal ID. JSON-encoded to keep one env var. |
| `SESSION_TTL_SECONDS` | `172800` | 48h — sessions auto-expire |
| `POLL_INTERVAL_MS` | `4000` | Client-side polling cadence |
| `ERROR_LOG_TTL_SECONDS` | `2592000` | 30d — fulfillment error logs auto-expire |
| `ALERT_WEBHOOK_URL` | *(Slack incoming webhook or similar)* | Posted to when step 2 fails and enters `fulfilled_pending_receipt` |
| `ALERT_WEBHOOK_ENABLED` | `true` | Kill switch for alerts during testing |

### 3.3 NetSuite role changes

Add the following permissions to the existing `Inventory Scanner API` role:

| Category | Permission | Level |
|---|---|---|
| Transactions | Transfer Order | View |
| Transactions | Fulfill Sales Orders | Full |
| Transactions | Item Fulfillment | Full |
| Transactions | Item Receipt | Full |

(The existing Inventory Adjustment and Item/Bin/Location view permissions stay.)

---

## 4. API contracts

### 4.1 `GET /api/transfer-orders`

**Query params:** `location` (internal ID, required)

**Returns:**
```json
{
  "orders": [
    {
      "id": "12345",
      "tranId": "TO149",
      "sourceLocationId": "3",
      "sourceLocationName": "Warehouse",
      "destinationLocationId": "17",
      "destinationLocationName": "Sales Floor",
      "status": "pendingFulfillment",
      "lineCount": 8,
      "totalQty": 42,
      "lockedBy": null,
      "lockedAt": null
    }
  ]
}
```

**Implementation:**
- SuiteQL query against `transaction` + `transactionline` joined to `location`, filtered by `type = 'TrnfrOrd'` and `status IN ('Pending Fulfillment', 'Partially Fulfilled')` and `location = :location`.
- `lockedBy` / `lockedAt` come from a KV scan of `session:to:*` keys where `toId` matches — included so the list UI can show lock state without a second round trip.

### 4.2 `GET /api/transfer-orders/:id`

**Returns:**
```json
{
  "id": "12345",
  "tranId": "TO149",
  "sourceLocationId": "3",
  "destinationLocationId": "17",
  "lines": [
    {
      "lineId": "1",
      "itemId": "9876",
      "sku": "SHIRT-BLUE-M",
      "description": "Blue Work Shirt - Medium",
      "qtyOrdered": 6,
      "qtyAlreadyFulfilled": 0,
      "binAvailability": [
        { "binId": "1001", "binNumber": "B-01-0001", "qtyOnHand": 3 },
        { "binId": "1042", "binNumber": "B-02-0014", "qtyOnHand": 5 }
      ]
    }
  ]
}
```

**Implementation:**
- Primary SuiteQL: TO header + lines (already know the pattern from Count Mode).
- Secondary SuiteQL: `binonhand` joined to `bin` where `item IN (:itemIds)` and `location = :sourceLocation`, only bins with `NVL(quantityonhand, 0) > 0`.
- Merge client-side in the serverless function before returning.

### 4.3 `POST /api/pick-sessions`

**Body:** `{ "toId": "12345", "pickerName": "Bryce" }`

**Behavior:**
- Check KV for existing `session:to:{toId}`.
- If exists and `pickerName` matches → return existing session (resume).
- If exists and `pickerName` differs → return 409 with `{ lockedBy, lockedAt }`.
- If not exists → create new session, return it.

**Session shape (KV value):**
```json
{
  "sessionId": "sess_abc123",
  "toId": "12345",
  "pickerName": "Bryce",
  "createdAt": "2026-04-20T14:00:00Z",
  "updatedAt": "2026-04-20T14:05:12Z",
  "status": "active",
  "events": [
    {
      "eventId": "evt_xyz",
      "timestamp": "2026-04-20T14:03:45Z",
      "type": "scan",
      "lineId": "1",
      "itemId": "9876",
      "binId": "1001",
      "qty": 1,
      "deviceId": "dev_001"
    }
  ]
}
```

**KV keys:**
- `session:to:{toId}` → session JSON (primary)
- `session:id:{sessionId}` → `toId` (reverse lookup, short TTL)

### 4.4 `PATCH /api/pick-sessions/:id`

**Body (append scan event):**
```json
{
  "type": "scan",
  "lineId": "1",
  "itemId": "9876",
  "binId": "1001",
  "qty": 1,
  "clientEventId": "evt_client_abc",
  "deviceId": "dev_001"
}
```

**Server-side validation (reject reasons):**
- `item_not_on_to` — itemId not found on any line
- `line_complete` — cumulative picked for this line already = qtyOrdered
- `bin_not_in_source_location` — bin doesn't belong to the TO's source location
- `conflict` — another event with same clientEventId already exists (idempotency)
- `session_taken_over` — session ownership changed since this request was initiated

**Success response:** full updated session (so client can reconcile).

**Other event types:**
- `switch_bin` — informational only, bookkeeping for the UI
- `pause` — sets `status: "paused"`
- `take_over` — changes pickerName, writes an event with previous/new picker

### 4.5 `GET /api/pick-sessions/:id`

Polled by the client every `POLL_INTERVAL_MS` while on the Pick Screen. Returns current session state. Client diffs against local state.

### 4.6 `POST /api/transfer-orders/:id/fulfill`

**Body:** `{ "sessionId": "sess_abc123" }`

**Behavior:**
1. Load session from KV.
2. Validate picker still owns it.
3. Reduce events → `{lineId, binId: qty}` map.
4. Build Item Fulfillment payload with `inventoryDetail.inventoryAssignment` per line citing source bins.
5. `POST /record/v1/transferorder/{id}/!transform/itemfulfillment` → get fulfillment internal ID.
6. Persist fulfillment ID to the session object in KV **before attempting receipt**. This is critical — if step 7 fails or the function times out mid-flight, the fulfillment ID is not lost.
7. Build Item Receipt payload targeting `NS_SALESFLOOR_BINS_JSON[destinationLocationId]`.
8. `POST /record/v1/itemfulfillment/{fulfillmentId}/!transform/itemreceipt` → get receipt internal ID.
9. Delete session from KV.
10. Return `{ fulfillmentId, receiptId, fullyFulfilled: bool }`.

**Failure handling:**

*Step 5 fails (Item Fulfillment not created):*
- Log error (see §4.8), session stays in KV with `status: "active"`, return error. User can retry normally — no inventory has moved in NetSuite.

*Step 8 fails (Item Fulfillment created, Item Receipt not created):*
- This is the dangerous case. Inventory is "in transit" in NetSuite.
- Mark session `status: "fulfilled_pending_receipt"` and store `fulfillmentId` on it.
- Log error (see §4.8) with full NetSuite response body.
- Fire alert webhook (see §4.9).
- Return `207 Multi-Status` with `{ status: "partial_success", fulfillmentId, errorMessage, retryUrl }`.
- Client shows a "Retry Receipt" button instead of normal complete flow, with message: *"Inventory was recorded as picked but has not yet landed in the salesfloor bin. Tap Retry Receipt to finish. Do not re-scan items."*

### 4.7 `POST /api/transfer-orders/:id/retry-receipt`

Dedicated endpoint for the step-8-failure recovery path. Skips everything up through step 6 since those are already done. Reads `fulfillmentId` from the session, retries only step 8.

**Body:** `{ "sessionId": "sess_abc123" }`

**Behavior:**
1. Load session from KV, confirm `status: "fulfilled_pending_receipt"` and `fulfillmentId` present.
2. Retry the receipt POST.
3. On success → delete session, return `{ receiptId, status: "complete" }`.
4. On failure → log, alert (with a dedupe flag to avoid alert spam on repeated retries), return error. Session stays in its pending state.

**Client-side auto-retry (in addition to manual retry):**
The client calls this endpoint with exponential backoff on initial failure before giving up and showing the manual Retry Receipt button. Schedule: 2s, 8s, 30s, then stop and hand off to the user. Most transient failures (NetSuite 5xx, cold-start timeouts) resolve inside the 30-second window.

### 4.8 Error logging

Whenever a fulfillment or receipt step fails, write a structured error record to KV:

**Key format:** `error:fulfillment:{timestamp}:{toId}`
**TTL:** `ERROR_LOG_TTL_SECONDS` (30 days)

**Payload:**
```json
{
  "timestamp": "2026-04-20T14:08:22Z",
  "toId": "12345",
  "tranId": "TO149",
  "sessionId": "sess_abc123",
  "pickerName": "Bryce",
  "step": "item_receipt",
  "fulfillmentId": "54321",
  "isRetry": false,
  "netsuite": {
    "status": 400,
    "statusText": "Bad Request",
    "body": { /* full NetSuite error JSON */ },
    "url": "https://.../record/v1/itemfulfillment/54321/!transform/itemreceipt"
  },
  "requestPayload": { /* what we sent to NetSuite */ }
}
```

**Why store the request payload:** when debugging, the #1 question is "what did we actually send?" Without this, reproducing the failure means re-deriving the payload from session events — possible but tedious.

**Why store the full NetSuite response body:** NetSuite's error JSON usually contains specific field-level validation messages (e.g. "binNumber 1234 is not valid for location 17"). The HTTP status alone is useless.

### 4.9 Alert webhook

When a session enters `fulfilled_pending_receipt` status, fire a webhook to `ALERT_WEBHOOK_URL`:

**Payload (Slack-compatible):**
```json
{
  "text": "⚠️ TO Fulfillment stuck pending receipt",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*TO149* — fulfillment created but receipt failed\n*Picker:* Bryce\n*Fulfillment ID:* 54321\n*Error:* <short message>\n<link to error log entry>"
      }
    }
  ]
}
```

**Dedupe rule:** only fire on the *first* entry into `fulfilled_pending_receipt` status per session. Auto-retry failures don't re-fire — otherwise you'd get 4 alerts for one stuck TO in under a minute. Manual retry failures also don't re-fire. One alert per stuck session, period.

**Kill switch:** if `ALERT_WEBHOOK_ENABLED !== 'true'`, skip. Useful during local dev and testing.

---

## 5. Frontend component structure

All new components in `src/pick/`:

```
src/
├── App.jsx                          # Add route switch for pick mode
├── pick/
│   ├── PickModeEntry.jsx            # Location selector (reuse existing)
│   ├── TOListScreen.jsx             # List of open TOs
│   ├── PickScreen.jsx               # Main pick UI (bin scan + item scan)
│   ├── TOLineRow.jsx                # Single line on pick screen
│   ├── BinScanPrompt.jsx            # "Scan a bin" state
│   ├── CompletePickModal.jsx        # Confirmation modal
│   ├── TakeoverModal.jsx            # "In progress by X" handler
│   └── usePickSession.js            # Hook: KV session state + polling
```

### Key UI rules
- Scan input handling mirrors Count Mode (InfoWedge → ENTER → input debounced).
- Beep feedback: distinct sounds for success / line-complete / hard-block.
- Bin display always visible in header once scanned.
- Lines sort: remaining > 0 first, complete lines at bottom and dimmed.
- Poll pauses when tab is hidden (`visibilitychange`) to save battery.

---

## 6. Design decisions

These are resolved. Do not re-open during implementation without explicit discussion.

### 6.1 Bin mismatch handling
**Decision:** Allow with warning, record anyway.

If an item is on the TO but not expected to be in the currently scanned bin per `binonhand`, the pick is recorded with a warning toast: *"Not expected in this bin — recording anyway."* Rationale: real-world bin counts drift, and refusing a legitimate physical pick because the database disagrees is worse than recording a pick that might indicate a pre-existing discrepancy. The warning creates a reviewable audit trail via the session event log.

### 6.2 Fulfillment-without-receipt recovery
**Decision:** Layered recovery — auto-retry with backoff, manual retry, logging, alerting.

Full handling specified in §4.6–§4.9. Summary of the layers:
1. Client-side auto-retry at 2s / 8s / 30s catches transient failures silently
2. Manual "Retry Receipt" button after auto-retry exhausts
3. Full NetSuite request/response logged to KV under `error:fulfillment:*`
4. Alert webhook fires once per session entering stuck state (dedupe rule in §4.9)

**Operational rule for pickers:** if you see "Retry Receipt," the stock has already been recorded as moved in NetSuite. Finish putting the stock in the salesfloor bin and tap Retry. **Do not put the stock back in the backroom.**

### 6.3 Take-over UX
**Decision:** Soft lock with time-weighted takeover button.

If a TO has an active session owned by another picker:
- Last activity ≤ 30 min → "In Progress by [name]" banner with a muted "Take Over" link
- Last activity > 30 min → prominent "Take Over" button
- Last activity > 4 hours → session is auto-released on next TO list load (treated as abandoned)

Takeover always writes a `take_over` event to the session log capturing both the previous and new picker names.

### 6.4 Source location binding
**Decision:** A TO's source location is set at TO creation in NetSuite and cannot be changed in this app.

The TO list is filtered by the user's selected source location on entry. Cross-location picking is not supported (NetSuite TOs are inherently single-source anyway, but this is called out so the implementation doesn't accidentally allow it via parameter manipulation).

---

## 7. Acceptance criteria

### Per screen

**TO List Screen**
- [ ] Loads all open TOs filtered by source location in < 3 sec on warehouse wifi
- [ ] Shows lock state accurately (polling once on mount is sufficient here)
- [ ] Tap-through to pick screen works
- [ ] Empty state when no open TOs

**Pick Screen — session creation**
- [ ] New session creates KV entry with correct shape
- [ ] Existing session for same picker → resumes
- [ ] Existing session for different picker → shows takeover modal
- [ ] "Take Over" transfers ownership and logs a `take_over` event

**Pick Screen — scanning**
- [ ] Bin scan queries `binonhand`, filters to remaining TO lines, renders per-line expected qty
- [ ] Item scan on valid item → increments, beeps success, updates line row
- [ ] Item scan for item not on TO → beep-error, toast "Not on this TO", no state change
- [ ] Item scan past qty ordered → beep-error, toast "Line complete", no state change
- [ ] Item scan when bin availability is zero for that item → warning toast but allowed (per §6.1)

**Pick Screen — live merge**
- [ ] Second device polling sees events from first device within `POLL_INTERVAL_MS * 2`
- [ ] Line remaining counts stay consistent across devices
- [ ] If device A picks the last unit of a line, device B's next scan of that item is hard-blocked with "Line complete"

**Pick Screen — pause/resume**
- [ ] Pause writes status to KV, returns to TO list
- [ ] Resume restores all picked quantities correctly
- [ ] 48-hour-old sessions auto-expire from KV

**Fulfillment**
- [ ] Complete Pick on fully-picked TO → fulfillment + receipt created, TO closes in NetSuite
- [ ] Complete Pick on partially-picked TO → fulfillment + receipt for picked qty only, TO stays open
- [ ] Fulfillment records correct per-bin inventory detail
- [ ] Receipt lands in correct salesfloor bin per `NS_SALESFLOOR_BINS_JSON`
- [ ] Successful fulfillment deletes session from KV

**Fulfillment — reliability & recovery**
- [ ] Fulfillment ID persists to KV immediately after step 5 succeeds, before receipt attempt
- [ ] Receipt failure → session transitions to `fulfilled_pending_receipt` with `fulfillmentId` stored
- [ ] Client auto-retries receipt at 2s, 8s, 30s; transient failures resolve silently
- [ ] After auto-retry exhausts → Retry Receipt button appears with correct messaging
- [ ] Manual Retry Receipt calls `/retry-receipt` endpoint, skips steps 1–6, only re-runs receipt
- [ ] Retry Receipt success → session cleared, TO closes normally

**Error logging**
- [ ] Every fulfillment or receipt failure writes a KV record under `error:fulfillment:{timestamp}:{toId}`
- [ ] Error record includes full NetSuite response body (not just HTTP status)
- [ ] Error record includes the exact request payload sent to NetSuite
- [ ] Error records TTL after 30 days (`ERROR_LOG_TTL_SECONDS`)

**Alerting**
- [ ] Webhook fires on first entry to `fulfilled_pending_receipt` status
- [ ] Webhook does NOT fire on subsequent auto-retry or manual-retry failures for the same session
- [ ] `ALERT_WEBHOOK_ENABLED=false` suppresses webhook entirely
- [ ] Webhook payload includes TO number, picker name, fulfillment ID, and short error message

### End-to-end
- [ ] Full happy path: open TO with 5 lines across 3 bins → pick all → complete → verify in NetSuite UI that TO is closed, Item Fulfillment exists with correct bin detail, Item Receipt exists with stock in salesfloor bin
- [ ] Multi-device: two phones on same TO, both scan alternating items, final state is correct
- [ ] Partial pick end-to-end: pick 3 of 5 lines fully → complete → TO shows remaining qty correctly on re-list

---

## 8. Build order

Suggested session sequence. Each session produces working, testable output before moving on.

1. **Session 1:** Vercel KV setup + session CRUD endpoints (no UI). Test with curl.
2. **Session 2:** TO list + TO detail endpoints. Test with curl, confirm SuiteQL returns expected data.
3. **Session 3:** PickModeEntry + TOListScreen UI. Read-only, no scanning.
4. **Session 4:** PickScreen core — bin scan, item scan, local state only (no KV sync yet).
5. **Session 5:** Wire PickScreen to KV session endpoints + polling for live merge.
6. **Session 6:** Fulfillment endpoint — Item Fulfillment + Item Receipt REST calls. Includes the fulfillment-ID persist-before-receipt pattern. Test happy path only (sandbox TO if available).
7. **Session 7:** Reliability pass — retry-receipt endpoint, client auto-retry with backoff, error logging to KV, alert webhook with dedupe. Test by deliberately breaking receipt (e.g. temporarily wrong bin ID in env var) to verify full failure path.
8. **Session 8:** CompletePickModal + error recovery UI states + polish.

Session 7 is explicitly separated from session 6 so the reliability layer gets its own review cycle rather than being rushed in alongside the core fulfillment logic.

---

## 9. Glossary

Terms used throughout this document. Most are NetSuite-native, a few are app-specific.

| Term | Meaning |
|---|---|
| **TO** | Transfer Order — NetSuite transaction that moves inventory between two locations. Has a source location, destination location, and line items with quantities. |
| **Item Fulfillment** | NetSuite transaction that records stock leaving the source location against a TO. Moves inventory into "in transit" status. |
| **Item Receipt** | NetSuite transaction that records stock arriving at the destination location against a fulfillment. Moves inventory out of "in transit" and into the destination bin. Closes the TO line. |
| **In Transit** | NetSuite inventory status between Item Fulfillment and Item Receipt. Stock is not counted at either location. |
| **Bin** | NetSuite sub-location within a location. Identified by an internal ID (numeric) and a bin number (human-readable, e.g. `F-01-0001`). |
| **`binonhand`** | NetSuite analytic record for current bin-level inventory. Query via SuiteQL joined to `bin`. Use `NVL({binonhand.quantityonhand}, 0)` for null safety. |
| **Inventory Detail** | NetSuite sublist on transactions, used to specify per-bin quantities via `inventoryassignment`. Required for bin-tracked items on fulfillments and receipts. |
| **TBA** | Token-Based Authentication — NetSuite's OAuth 1.0 implementation. Already configured for this app's existing SuiteQL calls; same credentials cover the new REST record API calls. |
| **Pick Mode** | New feature in this spec. Parallel to existing Count Mode. |
| **Session** | App-specific. A picker's in-progress work on a single TO. Lives in Vercel KV, expires after 48h, contains an append-only event log. |
| **Live merge** | App-specific. Multi-device concurrency via polling — two pickers on the same TO see each other's scans within ~4 seconds. |
| **Stuck TO** | App-specific. A TO in `fulfilled_pending_receipt` state — Item Fulfillment created but Item Receipt failed. Physical stock has moved, NetSuite books are half-updated. |
