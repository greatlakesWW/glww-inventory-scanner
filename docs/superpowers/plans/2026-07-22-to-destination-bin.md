# Destination Bin Selection — Pick Transfer Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the picker type/scan the destination bin in the Complete Pick modal, validate it live against NetSuite, and create the Item Receipt into that bin — replacing the hardcoded salesfloor-bin map.

**Architecture:** A shared server helper (`api/_bins.js`) resolves a bin number scoped to a location via SuiteQL. A new `GET /api/bins/validate` endpoint exposes it for live modal validation. The fulfill endpoint requires `destBinNumber`, re-resolves it server-side **before** creating the Item Fulfillment (bad bin → 400, no stuck TO), persists `destBinId`/`destBinNumber` into the KV session, and retry-receipt reads the bin from the session instead of the deleted hardcoded map.

**Tech Stack:** React 18 (inline styles, no CSS framework), Vercel serverless functions (plain `handler(req, res)`), NetSuite SuiteQL via `runSuiteQL`, vitest (+ jsdom/Testing Library for components).

**Spec:** `docs/superpowers/specs/2026-07-22-to-destination-bin-design.md`

**File map:**
- Create: `api/_bins.js` — location-scoped bin resolution (query builder + resolver with injectable query runner)
- Create: `api/_bins.test.js`
- Create: `api/bins/validate.js` — `GET /api/bins/validate?locationId=X&binNumber=Y`
- Create: `api/bins/validate.test.js`
- Modify: `src/pick/CompletePickModal.jsx` — required bin field with idle/checking/valid/invalid states
- Create: `src/pick/CompletePickModal.test.jsx`
- Modify: `src/pick/usePickSession.js` — `completeFulfill(destBinNumber)` includes bin in POST body
- Modify: `src/pick/PickScreen.jsx` — pass destination props + bin through `onConfirm`
- Modify: `api/transfer-orders/[id]/fulfill.js` — require + pre-validate `destBinNumber`, persist to session, delete `SALESFLOOR_BIN_DEFAULTS`
- Modify: `api/transfer-orders/[id]/retry-receipt.js` — read `session.destBinId`, delete hardcoded map

**Conventions:** run tests with `npx vitest run <file>` (config: `vitest.config.js`, node env by default; component tests start with `// @vitest-environment jsdom`). Commit after every green task.

---

### Task 1: Bin resolution helper (`api/_bins.js`)

**Files:**
- Create: `api/_bins.js`
- Test: `api/_bins.test.js`

- [ ] **Step 1: Write the failing tests**

Create `api/_bins.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { buildBinLookupQuery, resolveBinAtLocation } from "./_bins.js";

describe("buildBinLookupQuery", () => {
  it("scopes to location, filters inactive, matches case-insensitively", () => {
    const q = buildBinLookupQuery("f-01-0002", 3);
    expect(q).toContain("UPPER(binnumber) = UPPER('f-01-0002')");
    expect(q).toContain("location = 3");
    expect(q).toContain("isinactive = 'F'");
    expect(q).toContain("FETCH FIRST 1 ROWS ONLY");
  });

  it("escapes single quotes in the bin number", () => {
    const q = buildBinLookupQuery("O'BRIEN", 3);
    expect(q).toContain("UPPER('O''BRIEN')");
  });
});

describe("resolveBinAtLocation", () => {
  it("returns shaped { binId, binNumber } on a hit", async () => {
    const runner = vi.fn().mockResolvedValue({ items: [{ id: 42, binnumber: "F-01-0002" }] });
    const bin = await resolveBinAtLocation("f-01-0002", 3, runner);
    expect(bin).toEqual({ binId: "42", binNumber: "F-01-0002" });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("returns null when no rows match", async () => {
    const runner = vi.fn().mockResolvedValue({ items: [] });
    expect(await resolveBinAtLocation("NOPE", 3, runner)).toBeNull();
  });

  it("returns null without querying on empty bin number or bad location", async () => {
    const runner = vi.fn();
    expect(await resolveBinAtLocation("", 3, runner)).toBeNull();
    expect(await resolveBinAtLocation("  ", 3, runner)).toBeNull();
    expect(await resolveBinAtLocation("F-01-0002", 0, runner)).toBeNull();
    expect(await resolveBinAtLocation("F-01-0002", "abc", runner)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("trims whitespace from the bin number before querying", async () => {
    const runner = vi.fn().mockResolvedValue({ items: [{ id: 7, binnumber: "B-1" }] });
    await resolveBinAtLocation("  B-1  ", 3, runner);
    expect(runner.mock.calls[0][0]).toContain("UPPER('B-1')");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/_bins.test.js`
Expected: FAIL — `Cannot find module './_bins.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `api/_bins.js`:

```js
import { runSuiteQL } from "./_suiteql.js";

// ═══════════════════════════════════════════════════════════
// Location-scoped bin resolution.
//
// Used by GET /api/bins/validate (live modal validation) and by
// POST /api/transfer-orders/:id/fulfill (server-side re-validation
// before any NetSuite write). The location filter matters: bin
// numbers are only unique per location, so a global match could
// return a same-named bin at the wrong warehouse.
// ═══════════════════════════════════════════════════════════

export function buildBinLookupQuery(binNumber, locationId) {
  const escaped = String(binNumber).replace(/'/g, "''");
  return (
    `SELECT id, binnumber FROM Bin ` +
    `WHERE UPPER(binnumber) = UPPER('${escaped}') ` +
    `AND location = ${Number(locationId)} ` +
    `AND isinactive = 'F' ` +
    `FETCH FIRST 1 ROWS ONLY`
  );
}

/**
 * Resolve a bin number to its internal ID, scoped to a location.
 * Returns { binId, binNumber } (canonical NetSuite casing) or null.
 * `queryRunner` is injectable for tests; defaults to runSuiteQL.
 */
export async function resolveBinAtLocation(binNumber, locationId, queryRunner = runSuiteQL) {
  const name = typeof binNumber === "string" ? binNumber.trim() : "";
  const loc = Number(locationId);
  if (!name || !Number.isInteger(loc) || loc <= 0) return null;
  const { items } = await queryRunner(buildBinLookupQuery(name, loc));
  const row = Array.isArray(items) ? items[0] : null;
  if (!row || row.id == null) return null;
  return { binId: String(row.id), binNumber: row.binnumber || name };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/_bins.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_bins.js api/_bins.test.js
git commit -m "feat: location-scoped bin resolution helper"
```

---

### Task 2: `GET /api/bins/validate` endpoint

**Files:**
- Create: `api/bins/validate.js`
- Test: `api/bins/validate.test.js`

- [ ] **Step 1: Write the failing tests**

Create `api/bins/validate.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../_bins.js", () => ({ resolveBinAtLocation: vi.fn() }));
vi.mock("../_suiteql.js", () => ({ getSuiteQLConfig: vi.fn(() => ({})) }));

import handler from "./validate.js";
import { resolveBinAtLocation } from "../_bins.js";

function mockRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

const req = (query) => ({ method: "GET", query });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/bins/validate", () => {
  it("returns valid:true with binId and canonical binNumber on a hit", async () => {
    resolveBinAtLocation.mockResolvedValue({ binId: "42", binNumber: "F-01-0002" });
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "f-01-0002" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ valid: true, binId: "42", binNumber: "F-01-0002" });
    expect(resolveBinAtLocation).toHaveBeenCalledWith("f-01-0002", 3);
  });

  it("returns valid:false when the bin doesn't exist at the location", async () => {
    resolveBinAtLocation.mockResolvedValue(null);
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "NOPE" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it("400s on missing or non-numeric locationId", async () => {
    const res = mockRes();
    await handler(req({ binNumber: "B-1" }), res);
    expect(res.statusCode).toBe(400);
    const res2 = mockRes();
    await handler(req({ locationId: "abc", binNumber: "B-1" }), res2);
    expect(res2.statusCode).toBe(400);
  });

  it("400s on missing/blank binNumber", async () => {
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "   " }), res);
    expect(res.statusCode).toBe(400);
  });

  it("405s on non-GET", async () => {
    const res = mockRes();
    await handler({ method: "POST", query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it("surfaces SuiteQL failures as 500", async () => {
    resolveBinAtLocation.mockRejectedValue(new Error("SuiteQL 400: boom"));
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "B-1" }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain("boom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/bins/validate.test.js`
Expected: FAIL — cannot resolve `./validate.js`.

- [ ] **Step 3: Write the implementation**

Create `api/bins/validate.js`:

```js
import { resolveBinAtLocation } from "../_bins.js";
import { getSuiteQLConfig } from "../_suiteql.js";

// ═══════════════════════════════════════════════════════════
// GET /api/bins/validate?locationId=X&binNumber=Y
//
// Live validation for the Complete Pick modal's destination-bin
// field. Purely advisory for UX — the fulfill endpoint re-validates
// server-side before writing anything to NetSuite.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const locationId = Number(req.query?.locationId);
  const binNumber =
    typeof req.query?.binNumber === "string" ? req.query.binNumber.trim() : "";

  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: "'locationId' must be a positive integer" });
  }
  if (!binNumber) {
    return res.status(400).json({ error: "'binNumber' is required" });
  }

  try {
    getSuiteQLConfig(); // throws 500 with a helpful message if creds missing
    const bin = await resolveBinAtLocation(binNumber, locationId);
    if (!bin) return res.status(200).json({ valid: false });
    return res.status(200).json({ valid: true, binId: bin.binId, binNumber: bin.binNumber });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/bins/validate.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add api/bins/validate.js api/bins/validate.test.js
git commit -m "feat: GET /api/bins/validate for live destination-bin checks"
```

---

### Task 3: Destination bin field in CompletePickModal

**Files:**
- Modify: `src/pick/CompletePickModal.jsx`
- Test: `src/pick/CompletePickModal.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/pick/CompletePickModal.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import CompletePickModal from "./CompletePickModal";

const detail = {
  lines: [{ lineId: "1", sku: "GLV-1", description: "Test Glove", qtyRemaining: 2, itemId: "555" }],
  destinationLocationId: "3",
  destinationLocationName: "Store",
};
const pickedByLine = { 1: 2 };

const BIN_PLACEHOLDER = "Scan or type bin number…";
const CONFIRM_TEXT = /Confirm — create fulfillment/;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function renderModal(onConfirm = vi.fn()) {
  render(
    <CompletePickModal
      detail={detail}
      pickedByLine={pickedByLine}
      busy={false}
      error={null}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />
  );
  return { input: screen.getByPlaceholderText(BIN_PLACEHOLDER), onConfirm };
}

const enterBin = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

afterEach(() => { cleanup(); fetchMock.mockReset(); });

describe("CompletePickModal destination bin", () => {
  it("disables Confirm until a bin validates, even with items picked", () => {
    renderModal();
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
  });

  it("validates on Enter, shows canonical bin, enables Confirm, passes bin to onConfirm", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, binId: "42", binNumber: "F-01-0002" }),
    });
    const { input, onConfirm } = renderModal();
    enterBin(input, "f-01-0002");

    // Match the ✓ status line specifically — the canonical bin number also
    // appears in the modal subtitle once validated.
    await screen.findByText(/✓ F-01-0002/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bins/validate?locationId=3&binNumber=f-01-0002"
    );
    const confirm = screen.getByText(CONFIRM_TEXT);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ binId: "42", binNumber: "F-01-0002" });
  });

  it("shows a not-found message and keeps Confirm disabled on invalid bin", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ valid: false }) });
    const { input } = renderModal();
    enterBin(input, "X-99");

    await screen.findByText('Bin "X-99" not found at Store');
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
  });

  it("editing the field after a successful validation resets to unvalidated", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, binId: "42", binNumber: "F-01-0002" }),
    });
    const { input } = renderModal();
    enterBin(input, "F-01-0002");
    await screen.findByText(/✓/);

    fireEvent.change(input, { target: { value: "F-01-0003" } });
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
    expect(screen.queryByText(/✓/)).toBeNull();
  });

  it("shows an error message when the validate endpoint fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "SuiteQL down" }) });
    const { input } = renderModal();
    enterBin(input, "B-1");

    await screen.findByText(/SuiteQL down/);
    expect(screen.getByText(CONFIRM_TEXT).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pick/CompletePickModal.test.jsx`
Expected: FAIL — no element with placeholder `Scan or type bin number…`.

- [ ] **Step 3: Implement the bin field in `CompletePickModal.jsx`**

In `src/pick/CompletePickModal.jsx`:

3a. Change the imports line and add state (component top, after props destructure). Change:

```jsx
import { useMemo } from "react";
```

to:

```jsx
import { useMemo, useState } from "react";
```

3b. Inside the component, after the `totals` memo, add:

```jsx
  // ─── Destination bin (spec §1: type/scan + live validation) ───
  // binState: idle | checking | valid | invalid | error
  const [binInput, setBinInput] = useState("");
  const [binState, setBinState] = useState("idle");
  const [validatedBin, setValidatedBin] = useState(null); // { binId, binNumber }
  const [binMessage, setBinMessage] = useState(null);

  const destLocId = detail?.destinationLocationId;
  const destLocName = detail?.destinationLocationName || "destination";

  const validateBin = async () => {
    const raw = binInput.trim();
    if (!raw || binState === "checking") return;
    setBinState("checking");
    setBinMessage(null);
    try {
      const resp = await fetch(
        `/api/bins/validate?locationId=${encodeURIComponent(destLocId)}&binNumber=${encodeURIComponent(raw)}`
      );
      const data = await resp.json().catch(() => null);
      if (resp.ok && data?.valid) {
        setValidatedBin({ binId: String(data.binId), binNumber: data.binNumber });
        setBinInput(data.binNumber); // canonical casing
        setBinState("valid");
      } else if (resp.ok && data && data.valid === false) {
        setValidatedBin(null);
        setBinState("invalid");
        setBinMessage(`Bin "${raw}" not found at ${destLocName}`);
      } else {
        setValidatedBin(null);
        setBinState("error");
        setBinMessage(
          (data && typeof data === "object" && (data.error || data.message)) ||
            `Bin check failed (${resp.status})`
        );
      }
    } catch (e) {
      setValidatedBin(null);
      setBinState("error");
      setBinMessage(e.message || "Bin check failed");
    }
  };

  const onBinChange = (e) => {
    setBinInput(e.target.value);
    setBinState("idle");
    setValidatedBin(null);
    setBinMessage(null);
  };
```

3c. Update the header subtitle. Change:

```jsx
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            Creates an Item Fulfillment + Item Receipt in NetSuite. Stock moves
            from source bins into the salesfloor bin.
          </div>
```

to:

```jsx
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            Creates an Item Fulfillment + Item Receipt in NetSuite. Stock moves
            from source bins into{" "}
            {validatedBin ? (
              <span style={{ color: GREEN, fontWeight: 600, ...mono }}>
                {validatedBin.binNumber}
              </span>
            ) : (
              "the destination bin you enter below"
            )}
            {" "}at {destLocName}.
          </div>
```

3d. In the footer, directly **above** the `{nothingPicked && (` block, add the bin field:

```jsx
          {/* Destination bin — required before Confirm */}
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 11,
                color: "#94a3b8",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              Destination bin at {destLocName}
            </div>
            <input
              value={binInput}
              onChange={onBinChange}
              onKeyDown={(e) => { if (e.key === "Enter") validateBin(); }}
              onBlur={() => { if (binState === "idle" && binInput.trim()) validateBin(); }}
              placeholder="Scan or type bin number…"
              disabled={busy}
              autoFocus
              style={{
                ...S.inp,
                ...mono,
                borderColor:
                  binState === "valid"
                    ? GREEN
                    : binState === "invalid" || binState === "error"
                    ? "#ef4444"
                    : undefined,
              }}
            />
            {binState === "checking" && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>
                Checking bin…
              </div>
            )}
            {binState === "valid" && validatedBin && (
              <div style={{ fontSize: 12, color: GREEN, marginTop: 6, ...mono }}>
                ✓ {validatedBin.binNumber}
              </div>
            )}
            {(binState === "invalid" || binState === "error") && binMessage && (
              <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>
                {binMessage}
              </div>
            )}
          </div>
```

(`S.inp` is the app's shared input style from `src/shared.jsx:138` — it already includes `width: 100%` and `box-sizing`.)

3e. Gate the Confirm button on bin validity. Change:

```jsx
          <button
            onClick={onConfirm}
            disabled={busy || nothingPicked}
            style={{
              ...S.btn,
              background: GREEN,
              marginBottom: 8,
              opacity: busy || nothingPicked ? 0.5 : 1,
              cursor: busy || nothingPicked ? "not-allowed" : "pointer",
            }}
          >
```

to:

```jsx
          <button
            onClick={() => onConfirm(validatedBin)}
            disabled={busy || nothingPicked || binState !== "valid"}
            style={{
              ...S.btn,
              background: GREEN,
              marginBottom: 8,
              opacity: busy || nothingPicked || binState !== "valid" ? 0.5 : 1,
              cursor:
                busy || nothingPicked || binState !== "valid"
                  ? "not-allowed"
                  : "pointer",
            }}
          >
```

Also update the props doc comment at the top of the file: `onConfirm(bin)` — receives `{ binId, binNumber }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pick/CompletePickModal.test.jsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pick/CompletePickModal.jsx src/pick/CompletePickModal.test.jsx
git commit -m "feat: required destination-bin field with live validation in Complete Pick modal"
```

---

### Task 4: Wire the bin through PickScreen and usePickSession

**Files:**
- Modify: `src/pick/usePickSession.js` (completeFulfill, ~line 319)
- Modify: `src/pick/PickScreen.jsx` (CompletePickModal render, ~line 670)

- [ ] **Step 1: Update `completeFulfill` to accept and send the bin**

In `src/pick/usePickSession.js`, change:

```js
  const completeFulfill = useCallback(async () => {
    if (!session?.sessionId) throw new Error("No active session");
    if (!toId) throw new Error("Missing TO id");
```

to:

```js
  const completeFulfill = useCallback(async (destBinNumber) => {
    if (!session?.sessionId) throw new Error("No active session");
    if (!toId) throw new Error("Missing TO id");
    if (!destBinNumber) throw new Error("Missing destination bin");
```

and change the fetch body:

```js
          body: JSON.stringify({ sessionId: session.sessionId }),
```

to:

```js
          body: JSON.stringify({ sessionId: session.sessionId, destBinNumber }),
```

- [ ] **Step 2: Pass the bin from the modal in `PickScreen.jsx`**

Change:

```jsx
          onConfirm={async () => {
            setShowCompleteModal(false);
            try { await completeFulfill(); } catch { /* handled in hook */ }
          }}
```

to:

```jsx
          onConfirm={async (bin) => {
            setShowCompleteModal(false);
            try { await completeFulfill(bin?.binNumber); } catch { /* handled in hook */ }
          }}
```

(`detail` is already passed to the modal, and the modal reads `destinationLocationId`/`destinationLocationName` from it — no new props needed.)

- [ ] **Step 3: Run the full test suite + build**

Run: `npx vitest run`
Expected: PASS (all suites, including Tasks 1–3 tests and pre-existing tests).

Run: `npx vite build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pick/usePickSession.js src/pick/PickScreen.jsx
git commit -m "feat: pass destination bin from Complete Pick modal to fulfill request"
```

---

### Task 5: Fulfill endpoint — require, pre-validate, and persist the bin

**Files:**
- Modify: `api/transfer-orders/[id]/fulfill.js`

No new automated test — the bin logic lives in `api/_bins.js` (tested in Task 1); this task is mechanical rewiring verified by the existing suite plus the manual E2E in Task 7.

- [ ] **Step 1: Remove the hardcoded map and import the helper**

Delete the `SALESFLOOR_BIN_DEFAULTS` const and the entire `parseSalesfloorBins()` function (lines ~32–55), including their comments. Add to the imports:

```js
import { resolveBinAtLocation } from "../../_bins.js";
```

- [ ] **Step 2: Require `destBinNumber` in the request body**

After the `sessionId` parse/check:

```js
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return res.status(400).json({ error: "Missing 'sessionId' in request body" });
  }
```

add:

```js
  const destBinNumber =
    typeof body.destBinNumber === "string" ? body.destBinNumber.trim() : "";
  if (!destBinNumber) {
    return res.status(400).json({ error: "Missing 'destBinNumber' in request body" });
  }
```

- [ ] **Step 3: Resolve the bin BEFORE creating the Item Fulfillment**

Replace the old resolution block (after `lineMeta` is built, before the `─── STEP 7 ───` comment):

```js
  // Resolve destination bin. Defaults to the hardcoded GLWW map (location 3
  // → F-01-0001); NS_SALESFLOOR_BINS_JSON can add or override entries.
  const salesfloorMap = parseSalesfloorBins();
  if (!salesfloorMap || !salesfloorMap[destinationLocationId]) {
    return res.status(500).json({
      error:
        "No salesfloor bin configured for destination location " +
        destinationLocationId +
        '. Add it via NS_SALESFLOOR_BINS_JSON env var (e.g. {"' +
        destinationLocationId +
        '":"BIN-NUMBER"}) or extend SALESFLOOR_BIN_DEFAULTS in api/transfer-orders/[id]/fulfill.js.',
    });
  }
  const destBinNumber = String(salesfloorMap[destinationLocationId]);
```

with:

```js
  // Resolve the picker-chosen destination bin BEFORE any NetSuite write.
  // The client already validated it, but we never trust client state —
  // and doing this first means a bad bin is a clean 400, not a stuck TO
  // in fulfilled_pending_receipt.
  let destBin;
  try {
    destBin = await resolveBinAtLocation(destBinNumber, Number(destinationLocationId));
  } catch (e) {
    return res.status(500).json({ error: `Destination bin lookup failed: ${e.message}` });
  }
  if (!destBin) {
    return res.status(400).json({
      error: `Bin "${destBinNumber}" not found at destination location ${destinationLocationId}. Check the bin number and try again.`,
    });
  }
```

- [ ] **Step 4: Persist the bin with the fulfillmentId (STEP 8)**

Change:

```js
  try {
    await writeSession({
      ...session,
      fulfillmentId,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Failed to persist fulfillmentId to session:", e);
  }
```

to:

```js
  // Persist the bin alongside fulfillmentId so retry-receipt receives
  // into the picker's chosen bin, not a guessed default.
  session = {
    ...session,
    fulfillmentId,
    destBinId: destBin.binId,
    destBinNumber: destBin.binNumber,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeSession(session);
  } catch (e) {
    console.error("Failed to persist fulfillmentId to session:", e);
  }
```

(`session` is declared with `let` at the top of the handler, so reassignment is fine. The later `writeSession({ ...session, fulfillmentId, status: "fulfilled_pending_receipt", ... })` failure paths now automatically carry `destBinId`/`destBinNumber`.)

- [ ] **Step 5: Delete the old post-fulfillment bin lookup (STEP 9)**

Delete this entire block (the SuiteQL name→ID lookup and its 207 fallback — it's now dead, resolution happened in Step 3):

```js
  // Resolve destination bin NAME → internal ID via SuiteQL (the RESTlet
  // takes a bin internal id, not a name).
  let destBinId = null;
  try {
    const binQ = `SELECT id, binnumber FROM Bin WHERE binnumber = '${destBinNumber.replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
    const { items: binRows } = await runSuiteQL(binQ);
    if (binRows && binRows[0]?.id != null) destBinId = String(binRows[0].id);
  } catch (e) {
    console.error("Destination bin lookup failed:", e.message);
  }
  if (!destBinId) {
    try {
      await writeSession({
        ...session,
        fulfillmentId,
        status: "fulfilled_pending_receipt",
        updatedAt: new Date().toISOString(),
      });
    } catch {}
    return res.status(207).json({
      status: "partial_success",
      fulfillmentId,
      errorMessage: `Could not resolve destination bin "${destBinNumber}" to an internal ID. Check the bin exists at location ${destinationLocationId}.`,
      retryUrl: `/api/transfer-orders/${toId}/retry-receipt`,
    });
  }
```

In the RESTlet payload, change `destBinId: String(destBinId),` to `destBinId: String(destBin.binId),`.

If `runSuiteQL` is now unused in this file, remove it from the import (keep `getSuiteQLConfig`).

- [ ] **Step 6: Run the suite + build**

Run: `npx vitest run`
Expected: PASS.

Run: `node -e "import('./api/transfer-orders/[id]/fulfill.js').then(() => console.log('imports OK'))"`
Expected: `imports OK` (catches broken imports/syntax; the handler itself needs NetSuite creds to run).

- [ ] **Step 7: Commit**

```bash
git add "api/transfer-orders/[id]/fulfill.js"
git commit -m "feat: fulfill requires picker-chosen destination bin, validated before any NS write"
```

---

### Task 6: Retry-receipt reads the bin from the session

**Files:**
- Modify: `api/transfer-orders/[id]/retry-receipt.js`

- [ ] **Step 1: Remove the hardcoded map**

Delete the `SALESFLOOR_BIN_DEFAULTS` const (line ~28) and the `parseSalesfloorBins()` function (lines ~30–41).

- [ ] **Step 2: Read the bin from the session**

Replace this block:

```js
  // Resolve destination bin
  const salesfloorMap = parseSalesfloorBins();
  const destBinNumber = salesfloorMap[destinationLocationId];
  if (!destBinNumber) {
    return res.status(500).json({
      error: `No salesfloor bin configured for destination location ${destinationLocationId}`,
    });
  }

  let destBinId = null;
  try {
    const binQ = `SELECT id, binnumber FROM Bin WHERE binnumber = '${String(destBinNumber).replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
    const { items: binRows } = await runSuiteQL(binQ);
    if (binRows && binRows[0]?.id != null) destBinId = String(binRows[0].id);
  } catch (e) {
    console.error("Destination bin lookup failed:", e.message);
  }
  if (!destBinId) {
    return res.status(500).json({
      error: `Could not resolve bin "${destBinNumber}" to internal ID`,
    });
  }
```

with:

```js
  // Destination bin comes from the session — persisted by fulfill.js
  // before the receipt attempt (spec §3/§4). No fallback: silently
  // defaulting to a salesfloor bin would put stock in the wrong place.
  const destBinId = session.destBinId != null ? String(session.destBinId) : null;
  if (!destBinId) {
    return res.status(409).json({
      error:
        "Session has no destination bin recorded (it predates bin selection). " +
        "Delete the stuck session and re-run the pick's Complete step to choose a bin.",
      sessionId: session.sessionId,
      fulfillmentId,
    });
  }
```

The `destinationLocationId` extraction above it is now unused — delete this block too (the TO fetch itself stays, `tranId` is still used in responses and error logs):

```js
  const destLoc = to.transferLocation || {};
  const destinationLocationId = destLoc.id != null ? String(destLoc.id) : null;
  if (!destinationLocationId) {
    return res.status(502).json({ error: "TO has no destination location" });
  }
```

If `runSuiteQL` is now unused in this file, remove it from the import (keep `getSuiteQLConfig`).

- [ ] **Step 3: Verify imports + suite**

Run: `node -e "import('./api/transfer-orders/[id]/retry-receipt.js').then(() => console.log('imports OK'))"`
Expected: `imports OK`.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "api/transfer-orders/[id]/retry-receipt.js"
git commit -m "feat: retry-receipt uses the session's picker-chosen destination bin"
```

---

### Task 7: Full verification + manual E2E

**Files:** none (verification only)

- [ ] **Step 1: Full suite + build**

Run: `npx vitest run`
Expected: PASS, all suites.

Run: `npx vite build`
Expected: clean build.

- [ ] **Step 2: Grep for leftovers**

Run: `grep -rn "SALESFLOOR" api/ src/ && grep -rn "NS_SALESFLOOR_BINS_JSON" api/ src/`
Expected: **no matches** in either grep (the map and env var are fully gone). If `NS_SALESFLOOR_BINS_JSON` appears in docs/README, update those mentions to describe the new flow.

- [ ] **Step 3: Manual E2E against live NetSuite (requires user/deploy)**

This needs deployed serverless functions (Vercel preview) and a real TO. Checklist for the user (or run together on a preview deploy):

1. Open Transfers > Pick Transfer Orders, start a session on a small test TO, scan one item.
2. Tap Complete Pick → modal shows the new "Destination bin at <location>" field; Confirm is disabled.
3. Type a bogus bin (`ZZZ-TEST`) + Enter → red "not found" message, Confirm still disabled.
4. Type/scan a real bin at the destination location + Enter → green ✓ with canonical casing, Confirm enabled.
5. Confirm → success screen. In NetSuite, open the created Item Receipt and verify the inventory detail shows the chosen bin (not F-01-0001, unless chosen).
6. Retry path: intentionally hard to trigger — instead verify in Vercel KV (or logs) that the session carried `destBinId`/`destBinNumber` between the fulfill and receipt steps.

- [ ] **Step 4: Final commit (if any doc updates from Step 2)**

```bash
git add -A
git commit -m "docs: update env-var references for destination bin selection"
```

Then use superpowers:finishing-a-development-branch to integrate.
