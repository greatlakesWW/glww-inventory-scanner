# Destination Bin Selection — Pick Transfer Orders

**Date:** 2026-07-22
**Status:** Approved

## Problem

In Transfers > Pick Transfer Orders, the receiving side of a fulfill is
invisible to the picker: the Item Receipt always lands stock into a
hardcoded per-location bin (`SALESFLOOR_BIN_DEFAULTS` in
`api/transfer-orders/[id]/fulfill.js`, location 3 → `F-01-0001`,
overridable via the `NS_SALESFLOOR_BINS_JSON` env var). Pickers need to
choose which bin at the destination ("To") location the boxes are going
to, and the app should create the receiving entry with that bin.

## Decisions (from brainstorming)

- **When:** the picker enters the destination bin in the existing
  Complete Pick confirmation modal — no change to the scanning flow.
- **How:** a type/scan free-text field (scanner-gun friendly), not a
  dropdown.
- **Default:** none. The field starts empty and Confirm is disabled
  until a bin validates. The hardcoded default map is removed.
- **Validation:** live, in the modal, against NetSuite (Approach B),
  plus mandatory server-side re-validation before any NetSuite write.

## Design

### 1. UI — `src/pick/CompletePickModal.jsx`

- New required **"Destination bin"** text field in the modal footer,
  above the Confirm button.
- Enter key or blur triggers validation via the new endpoint (§2).
  States: idle → checking (spinner) → valid (green ✓ + canonical bin
  number) → invalid (red message, e.g. `Bin "X-99" not found at Store`,
  using `destinationLocationName` from the TO detail).
- Confirm stays disabled until the field is in the valid state. Editing
  the field after validation resets it to idle.
- The modal subtitle names the chosen bin instead of "the salesfloor
  bin".
- The validated `destBinNumber` is passed up through `onConfirm` into
  the fulfill POST body.

The TO detail response already exposes `destinationLocationId` and
`destinationLocationName` (`api/transfer-orders/[id].js`), so the modal
needs no new data from the detail endpoint.

### 2. New endpoint — `GET /api/bins/validate`

Query params: `locationId`, `binNumber`.

One SuiteQL query:

```sql
SELECT id, binnumber FROM Bin
WHERE UPPER(binnumber) = UPPER(:binNumber)
  AND location = :locationId
  AND isinactive = 'F'
FETCH FIRST 1 ROWS ONLY
```

Response: `{ valid: true, binId, binNumber }` (canonical NetSuite
casing) or `{ valid: false }`. 400 on missing/malformed params.

Note: this is stricter than the current fulfill-time lookup, which
matches `binnumber` globally with **no location filter** — a latent bug
(a same-named bin at another location could win). The location scope
fixes it.

### 3. Fulfill endpoint — `api/transfer-orders/[id]/fulfill.js`

- Request body adds required `destBinNumber`.
- The server **re-validates server-side** with the same location-scoped
  query (never trusts a client-resolved ID), **before creating the Item
  Fulfillment**. Invalid bin → 400 with a clear message; no NetSuite
  write happens, so a bad bin can no longer produce a stuck TO.
  (Today the bin lookup runs *after* the IF is created, which is exactly
  the window that produces `fulfilled_pending_receipt` sessions.)
- On successful resolution, `destBinId` and `destBinNumber` are
  persisted into the KV session in the same write that persists
  `fulfillmentId` (before the receipt attempt).
- The RESTlet call is unchanged — it already takes `destBinId`.
- `SALESFLOOR_BIN_DEFAULTS`, `parseSalesfloorBins()`, and the
  `NS_SALESFLOOR_BINS_JSON` env var are deleted.

### 4. Retry-receipt endpoint — `api/transfer-orders/[id]/retry-receipt.js`

- Reads `session.destBinId` (persisted in §3) instead of the hardcoded
  map, which is deleted here too.
- If a stuck session lacks `destBinId` (e.g. created before this
  deploy), return an actionable 409 error telling the operator to
  re-run the fulfill rather than silently defaulting to a salesfloor
  bin.

### 5. Error handling summary

| Failure | Behavior |
| --- | --- |
| Bin typo in modal | Inline red message; Confirm stays disabled |
| Validate endpoint down | Modal shows transient error; picker can retry validation |
| Bin invalid at fulfill time (race: deactivated between validate and confirm) | 400 before any NetSuite write; modal surfaces error, picker fixes and re-confirms |
| Receipt step fails | Unchanged: 207 `fulfilled_pending_receipt`; retry-receipt now uses the session's `destBinId` |

### 6. Testing

- **Component test** (`CompletePickModal` — mirror the
  `ItemReceipts.notOnPO.test.jsx` jsdom/Testing Library pattern):
  Confirm disabled until bin validates; invalid bin shows error;
  editing after validation resets to unvalidated; validated bin number
  included in confirm payload.
- **Unit test** on the extracted location-scoped bin-resolution helper
  used by fulfill/validate.
- **Manual end-to-end** against a live TO in NetSuite before merge
  (fulfill lands receipt in the chosen bin; retry path picks up
  `destBinId` from the session).

## Out of scope

- Per-line destination bins (one bin per receipt, per the request).
- Bin dropdown/browse UI at the destination location.
- Changes to the pick/scan flow or the RESTlet.
