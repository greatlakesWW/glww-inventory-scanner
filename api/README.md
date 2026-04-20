# API Endpoints

Vercel serverless functions under `/api/`. All endpoints are ESM, default-exported `handler(req, res)` functions.

For the Pick Mode feature spec and session lifecycle rules, see [`docs/FEATURE_SPEC_TO_FULFILLMENT.md`](../docs/FEATURE_SPEC_TO_FULFILLMENT.md) §4.3–§4.5.

---

## Pick Session Endpoints (Session 1)

Three endpoints manage the server-persisted pick session. State lives in Vercel KV (Upstash Redis) as an append-only event log per TO, with 48h TTL.

### Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/pick-sessions` | Create a new session or resume one owned by the same picker |
| `GET` | `/api/pick-sessions/:id` | Read current session state (used for polling) |
| `PATCH` | `/api/pick-sessions/:id` | Append an event (scan / switch_bin / pause / take_over) |

### KV key scheme (§4.3)

| Key | Value | TTL |
|---|---|---|
| `session:to:{toId}` | Full session JSON (primary store) | `SESSION_TTL_SECONDS` (48h default) |
| `session:id:{sessionId}` | `toId` string (reverse lookup) | Same TTL |

Both keys are refreshed to the full TTL on every write, so active sessions don't expire mid-flight. A session's authoritative copy is `session:to:{toId}`; the reverse lookup exists so `/pick-sessions/:id` can resolve without an indexing scan.

### Session shape

```json
{
  "sessionId": "sess_abc123def456ab01",
  "toId": "12345",
  "pickerName": "Bryce",
  "createdAt": "2026-04-20T14:00:00.000Z",
  "updatedAt": "2026-04-20T14:05:12.000Z",
  "status": "active",
  "events": [
    {
      "eventId": "evt_xy01ab23cd45",
      "clientEventId": "evt_client_abc",
      "timestamp": "2026-04-20T14:03:45.000Z",
      "deviceId": "dev_001",
      "type": "scan",
      "lineId": "1",
      "itemId": "9876",
      "binId": "1001",
      "qty": 1
    }
  ]
}
```

`status` is one of `active` | `paused` | `fulfilled_pending_receipt`. The third value is reserved for the recovery path in session 7 and is not set by these endpoints.

### Event types (PATCH body)

| `type` | Required fields | Effect |
|---|---|---|
| `scan` | `pickerName`, `lineId`, `itemId`, `binId`, `qty`, `clientEventId` | Appends the scan; server-side TO validations (`item_not_on_to`, `line_complete`, `bin_not_in_source_location`) will be added in session 2/5 |
| `switch_bin` | `pickerName`, `binId`, `clientEventId` | Informational bookkeeping for the UI |
| `pause` | `pickerName`, `clientEventId` | Sets `status = "paused"` |
| `take_over` | `newPickerName`, `clientEventId` | Transfers ownership; event records `previousPicker` and `newPicker`; sets `status = "active"` |

Every PATCH requires `clientEventId` for idempotency. Replaying the same `clientEventId` returns the current session unchanged (no duplicate event, 200 OK).

Every PATCH except `take_over` also requires `pickerName` matching the session's current owner. A mismatch returns 409 `{ error: "session_taken_over" }`.

### Response codes

| Endpoint | Code | Meaning |
|---|---|---|
| POST | `201` | Created new session |
| POST | `200` | Resumed existing session (same picker) |
| POST | `409` | Session locked by a different picker (body: `{ error, lockedBy, lockedAt, sessionId }`) |
| POST | `400` | Missing `toId` or `pickerName` |
| GET | `200` | Session returned |
| GET | `404` | No session for that sessionId |
| PATCH | `200` | Event appended (or replay detected — idempotent no-op) |
| PATCH | `400` | Malformed event body |
| PATCH | `404` | Session not found |
| PATCH | `409` | `pickerName` doesn't match current owner |

---

## Smoke test (curl)

Run against a local Vercel dev server (`vercel dev`) or deployed preview. Export `BASE=http://localhost:3000` (or the deployment URL).

```bash
# 1. Create — expect 201
curl -sX POST $BASE/api/pick-sessions \
  -H "Content-Type: application/json" \
  -d '{"toId":"99999","pickerName":"Alice"}' | tee /tmp/sess.json

SESSION_ID=$(jq -r .sessionId /tmp/sess.json)
echo "SESSION_ID=$SESSION_ID"

# 2. Create again as same picker — expect 200, same sessionId
curl -sX POST $BASE/api/pick-sessions \
  -H "Content-Type: application/json" \
  -d '{"toId":"99999","pickerName":"Alice"}'

# 3. Create as different picker — expect 409 with lockedBy/lockedAt
curl -sX POST $BASE/api/pick-sessions \
  -H "Content-Type: application/json" \
  -d '{"toId":"99999","pickerName":"Bob"}'

# 4. Append a scan — expect 200 with event appended
curl -sX PATCH $BASE/api/pick-sessions/$SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"type":"scan","pickerName":"Alice","lineId":"1","itemId":"9876","binId":"1001","qty":1,"clientEventId":"evt_c1","deviceId":"dev_001"}'

# 5. Replay same clientEventId — expect 200 with same session (no duplicate)
curl -sX PATCH $BASE/api/pick-sessions/$SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"type":"scan","pickerName":"Alice","lineId":"1","itemId":"9876","binId":"1001","qty":1,"clientEventId":"evt_c1","deviceId":"dev_001"}'

# 6. Take over — expect 200, pickerName now Bob
curl -sX PATCH $BASE/api/pick-sessions/$SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"type":"take_over","newPickerName":"Bob","clientEventId":"evt_takeover_1","deviceId":"dev_002"}'

# 7. GET — expect full session with all events, pickerName = "Bob"
curl -s $BASE/api/pick-sessions/$SESSION_ID
```

### Windows / PowerShell gotcha

On Windows, PowerShell passes args through Windows' `CommandLineToArgvW` before reaching `curl.exe`, which consumes unescaped `"` as argument delimiters. So `-d '{"toId":"99999"}'` reaches curl as `{toId:99999}` — invalid JSON, and Vercel's body parser returns 400 with an empty body before your handler runs.

Escape inner quotes with backslashes to preserve them through the Windows arg parser:

```powershell
$BASE = "https://your-deploy.vercel.app"

# 1. Create — note the \" inside the JSON string
$r1 = curl.exe -sX POST "$BASE/api/pick-sessions" -H "Content-Type: application/json" `
  -d '{\"toId\":\"99999\",\"pickerName\":\"Alice\"}'
$SID = ($r1 | ConvertFrom-Json).sessionId

# 4. Append scan
curl.exe -sX PATCH "$BASE/api/pick-sessions/$SID" -H "Content-Type: application/json" `
  -d '{\"type\":\"scan\",\"pickerName\":\"Alice\",\"lineId\":\"1\",\"itemId\":\"9876\",\"binId\":\"1001\",\"qty\":1,\"clientEventId\":\"evt_c1\",\"deviceId\":\"dev_001\"}'

# 6. Take over
curl.exe -sX PATCH "$BASE/api/pick-sessions/$SID" -H "Content-Type: application/json" `
  -d '{\"type\":\"take_over\",\"newPickerName\":\"Bob\",\"clientEventId\":\"evt_takeover_1\",\"deviceId\":\"dev_002\"}'
```

Symptom when you forget to escape: HTTP 400 with `Content-Length: 0` and no `Content-Type` response header. That's Vercel's body parser rejecting malformed JSON before the handler runs.

### Covers acceptance criteria (§7 "Pick Screen — session creation")
- [x] New session creates KV entry with correct shape — step 1
- [x] Existing session for same picker → resumes — step 2
- [x] Existing session for different picker → shows takeover modal — step 3 (client uses 409 body)
- [x] "Take Over" transfers ownership and logs a `take_over` event — step 6

---

## Environment variables

Required for the pick session endpoints:

| Var | Description |
|---|---|
| `KV_REST_API_URL` | Upstash REST endpoint (auto-set when the Vercel KV / Upstash integration is attached) |
| `KV_REST_API_TOKEN` | Upstash REST token (auto-set) |
| `SESSION_TTL_SECONDS` | Defaults to `172800` (48h) if unset |

The existing NetSuite TBA variables (`NS_ACCOUNT_ID`, `NS_CONSUMER_KEY`, `NS_CONSUMER_SECRET`, `NS_TOKEN_ID`, `NS_TOKEN_SECRET`) remain required for the other endpoints (`suiteql.js`, `record.js`, `adjust.js`).

---

## Other endpoints (unchanged)

| File | Purpose |
|---|---|
| `suiteql.js` | POST proxy for NetSuite SuiteQL queries (TBA OAuth 1.0) |
| `record.js` | POST proxy for NetSuite REST record API |
| `adjust.js` | Inventory adjustment wrapper (handles bin-ID lookup + payload build) |
| `email.js` | Transactional email via Resend |
| `_auth.js` | NetSuite OAuth 1.0 signing helpers |
| `_kv.js` | KV helpers for pick sessions (keys, TTL, read/write) |
