# Cross-Location Moves in Bin Transfer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a worker move inventory from a bin at one location to a bin at a different location in one instant NetSuite transaction, inside the existing Bin Transfer module.

**Architecture:** The Bin Transfer destination step gains a "To Location" chip selector defaulting to the source location. Destination-bin validation runs against the selected destination location. At submit, same-location moves post the existing `bintransfer` record; cross-location moves post a one-step `inventorytransfer` (`location` = source, `transferlocation` = destination, lines carry `adjustqtyby` + from/to bin inventory detail). No new endpoints — both records go through the existing `/api/record` proxy via `nsRecord()`.

**Tech Stack:** React (single-file module `src/modules/BinTransfer.jsx`), NetSuite REST record API via `/api/record`, SuiteQL via `/api/suiteql`, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-07-cross-location-bin-transfer-design.md`

**How to run NetSuite probes below:** point requests at the running app — either the deployed Vercel URL or a local `vercel dev` with the NetSuite env vars set (`NS_ACCOUNT_ID`, `NS_CONSUMER_KEY`, `NS_CONSUMER_SECRET`, `NS_TOKEN_ID`, `NS_TOKEN_SECRET`). Substitute `$APP` for that base URL in the commands.

---

## Phase 0 — NetSuite Verification Probes (GATE)

**Do not build anything past Phase 0 until both probes pass.** `bintransfer` POST is known-good in this account and transforms are the known RESTlet-only dead end, but plain `POST /inventorytransfer` with bin-level detail is unproven. If a probe fails, STOP and report — the fallback (a small RESTlet mirroring `netsuite/receiveTransferOrder.js`) changes Phase 1's submit path and must be re-planned.

### Task 0.1: Probe — does the REST record API expose `inventorytransfer`?

- [ ] **Step 1: List the record type through the proxy**

```bash
curl -s -X POST "$APP/api/record" -H "Content-Type: application/json" -d '{"method":"GET","path":"inventorytransfer?limit=1"}'
```

Expected (PASS): HTTP 200 with `{"status":200,"data":{"items":[...],...}}` — an empty `items` array is still a PASS (record type exists, none created yet).
Expected (FAIL): `{"status":404,...}` or an error naming an invalid record type.

- [ ] **Step 2: Decision gate**

- PASS → Task 0.2.
- FAIL → STOP. Report that `inventorytransfer` is not REST-accessible in this account; the RESTlet fallback needs its own plan revision.

### Task 0.2: Probe — live 1-unit cross-location transfer with bin detail (then reverse it)

- [ ] **Step 1: Pick a low-risk candidate item and bins**

List active locations, then find an item with stock in a bin at the source location, and any bin at the destination location:

```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{"query":"SELECT id, name FROM location WHERE isinactive = '"'"'F'"'"' ORDER BY name"}'
```

Choose a source location `SRC_LOC` (backroom/warehouse) and destination `DEST_LOC` (e.g. Sales Floor), then:

```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{"query":"SELECT ib.item AS item_id, item.itemid AS sku, ib.quantityonhand, ib.binnumber AS bin_id, BUILTIN.DF(ib.binnumber) AS bin_number FROM inventorybalance ib JOIN item ON item.id = ib.item WHERE ib.location = SRC_LOC AND ib.quantityonhand > 1 FETCH FIRST 5 ROWS ONLY"}'
```

```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{"query":"SELECT id AS bin_id, binnumber FROM Bin WHERE location = DEST_LOC FETCH FIRST 5 ROWS ONLY"}'
```

Record: `ITEM_ID`, `SRC_BIN_ID`, `DEST_BIN_ID`, `SRC_LOC`, `DEST_LOC`.

- [ ] **Step 2: POST the 1-unit inventory transfer**

```bash
curl -s -X POST "$APP/api/record" -H "Content-Type: application/json" -d '{
  "method": "POST",
  "path": "inventorytransfer",
  "body": {
    "subsidiary": { "id": "2" },
    "location": { "id": "SRC_LOC" },
    "transferlocation": { "id": "DEST_LOC" },
    "memo": "PROBE cross-loc transfer - reverse me",
    "inventory": { "items": [{
      "item": { "id": "ITEM_ID" },
      "adjustqtyby": 1,
      "inventorydetail": { "inventoryAssignment": { "items": [{
        "binNumber": { "id": "SRC_BIN_ID" },
        "toBinNumber": { "id": "DEST_BIN_ID" },
        "quantity": 1
      }] } }
    }] }
  }
}'
```

Expected (PASS): `{"status":204,"location":"...inventorytransfer/<id>"}`.
Expected (soft FAIL): 400 naming an unknown/invalid field — the error's `o:errorDetails` lists what NetSuite expected (e.g. `adjustQtyBy` casing, or a differently named sublist). Adjust the payload per the error and retry once or twice; if it saves, record the exact working field names — **Phase 1 must use those names**.
Expected (hard FAIL): error saying the record type is unsupported for POST, or bin detail cannot be set.

- [ ] **Step 3: Verify stock actually moved**

```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{"query":"SELECT ib.location, BUILTIN.DF(ib.binnumber) AS bin_number, ib.quantityonhand FROM inventorybalance ib WHERE ib.item = ITEM_ID AND ib.location IN (SRC_LOC, DEST_LOC)"}'
```

Expected: source bin down 1, destination bin up 1.

- [ ] **Step 4: Reverse the probe transfer**

Same POST as Step 2 with `location`/`transferlocation` swapped and `binNumber`/`toBinNumber` swapped, memo `"PROBE reversal"`. Re-run Step 3's query and confirm quantities are back to the originals.

- [ ] **Step 5: Decision gate**

- PASS (moved and reversed cleanly) → Phase 1. Note the exact working payload field names at the top of the working notes.
- Hard FAIL → STOP. Report; RESTlet fallback requires plan revision.

---

## Phase 1 — Component Changes (TDD)

All work is in `src/modules/BinTransfer.jsx` plus one new test file. Read the module top-to-bottom first — phases are `location → scan-source → scan-items → scan-dest → review`, state persists to `localStorage` under `glww_bin_transfer`, and `ResumePrompt` shows on mount when a saved session exists.

**If Task 0.2 settled on different field names than shown here, use those in both the tests and the implementation.**

### Task 1.1: Test scaffold + "To Location" selector drives dest-bin validation

**Files:**
- Create: `src/modules/BinTransfer.crossLocation.test.jsx`
- Modify: `src/modules/BinTransfer.jsx`

- [ ] **Step 1: Write the test file with two failing tests**

```jsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import BinTransfer from "./BinTransfer";

const SESSION_KEY = "glww_bin_transfer";

const LOC_WH = { id: "1", name: "Warehouse" };
const LOC_SF = { id: "3", name: "Sales Floor" };

// Session parked on the destination step so the component mounts straight
// there (after Resume) with no phase-1/2/3 network calls.
const destSession = {
  phase: "scan-dest",
  locations: [LOC_WH, LOC_SF],
  selectedLocation: LOC_WH,
  sourceBin: { bin_id: "11", bin_number: "B-01-0001" },
  binContents: [{
    item_id: 555, sku: "GLV-1", item_name: "Test Glove", upc: "012345678905",
    qty_in_bin: 5, qty_available: 5, bin_id: "11", bin_number: "B-01-0001",
  }],
  moveItems: { 555: 2 },
  scanHistory: [555, 555],
  destBin: null,
};

let fetchCalls;
beforeEach(() => {
  fetchCalls = [];
  global.fetch = vi.fn(async (url, opts) => {
    const body = JSON.parse(opts.body);
    fetchCalls.push({ url, body });
    if (url === "/api/suiteql") {
      // Dest-bin validation query — always "found"
      return { ok: true, json: async () => ({ items: [{ bin_id: "99", bin_number: "F-01-0001" }] }) };
    }
    if (url === "/api/record") {
      return { ok: true, text: async () => JSON.stringify({ status: 204 }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

// Simulate a scanner gun: type the value, then Enter.
const scan = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

function renderDestScreen(session = destSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  render(<BinTransfer onBack={() => {}} />);
  fireEvent.click(screen.getByText("Resume Session"));
  return screen.getByPlaceholderText("Scan bin to move to...");
}

const suiteqlQueries = () =>
  fetchCalls.filter(c => c.url === "/api/suiteql").map(c => c.body.query);

describe("To Location selector", () => {
  it("defaults to the source location and validates the bin there", async () => {
    const input = renderDestScreen();
    // Chip row exists; source location chip is present as a button
    expect(screen.getByText("To Location")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Warehouse" })).toBeTruthy();
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    const q = suiteqlQueries().pop();
    expect(q).toContain("location = 1"); // validated against source loc
  });

  it("validates against the selected destination location instead", async () => {
    const input = renderDestScreen();
    fireEvent.click(screen.getByRole("button", { name: "Sales Floor" }));
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    const q = suiteqlQueries().pop();
    expect(q).toContain("location = 3");
    expect(q).not.toContain("location = 1");
  });
});
```

- [ ] **Step 2: Run and verify both tests fail**

```bash
npx vitest run src/modules/BinTransfer.crossLocation.test.jsx
```

Expected: FAIL — `Unable to find an element with the text: To Location` (the selector doesn't exist yet).

- [ ] **Step 3: Implement the selector and location-aware validation**

In `src/modules/BinTransfer.jsx`:

**3a.** Add state next to the `destBin` state (around line 47):

```jsx
  // ── Phase 4: Destination bin ──
  const [destBin, setDestBin] = useState(saved?.destBin || null); // { bin_id, bin_number }
  const [destLocation, setDestLocation] = useState(saved?.destLocation || null); // { id, name }
```

**3b.** Persist and restore it. Add `destLocation` to the `saveSession` object and its dependency array (lines 63–71), and to `handleResume`:

```jsx
      setDestBin(saved.destBin || null);
      setDestLocation(saved.destLocation || null);
```

**3c.** Default it when entering the destination phase. Change the "Select Destination" button handler (line 637):

```jsx
              <button
                onClick={() => {
                  setDestLocation(prev => prev || selectedLocation);
                  setPhase("scan-dest");
                }}
```

**3d.** Rework `handleDestBinScan` (lines 243–277) to validate against the destination location. Replace the whole callback:

```jsx
  const handleDestBinScan = useCallback(async (val) => {
    const trimmed = val.trim();
    const destLoc = destLocation || selectedLocation;
    if (!trimmed || !destLoc) return;
    setError(null);
    setLoading(true);
    try {
      const sameLocation = String(destLoc.id) === String(selectedLocation.id);
      // Same bin is only a conflict within the same location — bin numbers
      // can repeat across locations.
      if (sameLocation && trimmed.toUpperCase() === sourceBin?.bin_number?.toUpperCase()) {
        beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
        setError("Destination must be different from source");
        setLoading(false);
        return;
      }

      // Validate bin exists at the destination location via Bin table (works for empty bins too)
      const bins = await suiteql(`
        SELECT id AS bin_id, binnumber AS bin_number
        FROM Bin
        WHERE binnumber = '${trimmed.replace(/'/g, "''")}'
          AND location = ${destLoc.id}
      `);
      if (bins.length === 0) {
        beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
        setError(`Bin not found at ${destLoc.name}`);
        setLoading(false);
        return;
      }

      setDestBin(bins[0]);
      beepBin(); setFlash("bin"); setTimeout(() => setFlash(null), 400);
      setPhase("review");
    } catch (e) {
      beepWarn(); setError(`Bin lookup failed: ${e.message}`);
    } finally { setLoading(false); }
  }, [selectedLocation, sourceBin, destLocation]);
```

**3e.** Render the chip row in the `scan-dest` phase, between the "Scan Destination Bin" heading block and the error/loading indicators (after line 687):

```jsx
            {/* To Location selector */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ ...S.lbl, marginBottom: 6 }}>To Location</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {locations.map(loc => {
                  const active = String((destLocation || selectedLocation).id) === String(loc.id);
                  return (
                    <button
                      key={loc.id}
                      onClick={() => { setDestLocation(loc); setDestBin(null); setError(null); }}
                      style={{
                        ...S.btnSm, fontSize: 12, padding: "6px 12px",
                        background: active ? `${ACCENT}20` : "rgba(255,255,255,0.04)",
                        border: `1px solid ${active ? ACCENT : "rgba(255,255,255,0.08)"}`,
                        color: active ? ACCENT : "#94a3b8",
                        fontWeight: active ? 700 : 500,
                      }}
                    >{loc.name}</button>
                  );
                })}
              </div>
            </div>
```

- [ ] **Step 4: Run tests, verify both pass**

```bash
npx vitest run src/modules/BinTransfer.crossLocation.test.jsx
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinTransfer.jsx src/modules/BinTransfer.crossLocation.test.jsx
git commit -m "feat: To Location selector on Bin Transfer destination step"
```

### Task 1.2: Same-bin rule — rejected same-location, allowed cross-location

**Files:**
- Modify: `src/modules/BinTransfer.crossLocation.test.jsx`

- [ ] **Step 1: Add the tests**

Append to the test file:

```jsx
describe("same-bin rule", () => {
  it("rejects the source bin as destination within the same location", async () => {
    const input = renderDestScreen();
    scan(input, "B-01-0001");
    await screen.findByText("Destination must be different from source");
    expect(suiteqlQueries().length).toBe(0); // rejected before any lookup
  });

  it("allows the same bin number at a different location", async () => {
    const input = renderDestScreen();
    fireEvent.click(screen.getByRole("button", { name: "Sales Floor" }));
    scan(input, "B-01-0001");
    await screen.findByText("Review Transfer");
    expect(suiteqlQueries().pop()).toContain("location = 3");
  });
});
```

- [ ] **Step 2: Run — both should already pass (behavior landed in Task 1.1's rework)**

```bash
npx vitest run src/modules/BinTransfer.crossLocation.test.jsx
```

Expected: 4 passed. If either fails, fix `handleDestBinScan` — the same-bin guard must be inside the `sameLocation` condition and must run before the SuiteQL lookup.

- [ ] **Step 3: Commit**

```bash
git add src/modules/BinTransfer.crossLocation.test.jsx
git commit -m "test: same-bin rule scoped to same-location transfers"
```

### Task 1.3: Submit branching — bintransfer vs inventorytransfer

**Files:**
- Modify: `src/modules/BinTransfer.crossLocation.test.jsx`
- Modify: `src/modules/BinTransfer.jsx` (submit handler, lines 288–343)

- [ ] **Step 1: Write the failing tests**

Append:

```jsx
const recordCalls = () => fetchCalls.filter(c => c.url === "/api/record").map(c => c.body);

describe("submit payload branching", () => {
  it("posts a bintransfer when locations match", async () => {
    const input = renderDestScreen();
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    fireEvent.click(screen.getByText("Confirm Transfer"));
    await screen.findByText("Bin Transfer Complete");

    const [call] = recordCalls();
    expect(call.method).toBe("POST");
    expect(call.path).toBe("bintransfer");
    expect(call.body.location).toEqual({ id: "1" });
    expect(call.body.transferlocation).toBeUndefined();
    const line = call.body.inventory.items[0];
    expect(line.item).toEqual({ id: "555" });
    expect(line.quantity).toBe(2);
    const asn = line.inventoryDetail.inventoryAssignment.items[0];
    expect(asn).toEqual({ binNumber: { id: "11" }, toBinNumber: { id: "99" }, quantity: 2 });
  });

  it("posts an inventorytransfer when locations differ", async () => {
    const input = renderDestScreen();
    fireEvent.click(screen.getByRole("button", { name: "Sales Floor" }));
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    fireEvent.click(screen.getByText("Confirm Transfer"));
    await screen.findByText("Bin Transfer Complete");

    const [call] = recordCalls();
    expect(call.path).toBe("inventorytransfer");
    expect(call.body.subsidiary).toEqual({ id: "2" });
    expect(call.body.location).toEqual({ id: "1" });
    expect(call.body.transferlocation).toEqual({ id: "3" });
    const line = call.body.inventory.items[0];
    expect(line.item).toEqual({ id: "555" });
    expect(line.adjustqtyby).toBe(2);
    const asn = line.inventorydetail.inventoryAssignment.items[0];
    expect(asn).toEqual({ binNumber: { id: "11" }, toBinNumber: { id: "99" }, quantity: 2 });
  });
});
```

(If Task 0.2 proved different field names — e.g. `adjustQtyBy` — use the proven names here and in Step 3.)

- [ ] **Step 2: Run, verify the cross-location test fails**

```bash
npx vitest run src/modules/BinTransfer.crossLocation.test.jsx
```

Expected: same-location test passes; cross-location test FAILS with `expected 'bintransfer' to be 'inventorytransfer'`.

- [ ] **Step 3: Implement the branch in `handleSubmit`**

Replace the record-creation block (the `inventoryLines` build and `nsRecord` call, lines 293–313) with:

```jsx
      const isCrossLocation =
        destLocation && String(destLocation.id) !== String(selectedLocation.id);

      if (isCrossLocation) {
        // One-step Inventory Transfer: stock moves source-bin → dest-bin
        // across locations instantly, no in-transit state.
        const transferLines = movingItemsList.map(item => ({
          item: { id: String(item.item_id) },
          adjustqtyby: Number(item.move_qty),
          inventorydetail: {
            inventoryAssignment: {
              items: [{
                binNumber: { id: String(sourceBin.bin_id) },
                toBinNumber: { id: String(destBin.bin_id) },
                quantity: Number(item.move_qty),
              }],
            },
          },
        }));

        await nsRecord("POST", "inventorytransfer", {
          subsidiary: { id: "2" },
          location: { id: String(selectedLocation.id) },
          transferlocation: { id: String(destLocation.id) },
          memo: `${sourceBin.bin_number} @ ${selectedLocation.name} to ${destBin.bin_number} @ ${destLocation.name}`.slice(0, 40),
          inventory: { items: transferLines },
        });
      } else {
        const inventoryLines = movingItemsList.map(item => ({
          item: { id: String(item.item_id) },
          quantity: Number(item.move_qty),
          inventoryDetail: {
            inventoryAssignment: {
              items: [{
                binNumber: { id: String(sourceBin.bin_id) },
                toBinNumber: { id: String(destBin.bin_id) },
                quantity: Number(item.move_qty),
              }],
            },
          },
        }));

        await nsRecord("POST", "bintransfer", {
          subsidiary: { id: "2" },
          location: { id: String(selectedLocation.id) },
          memo: `${sourceBin.bin_number} to ${destBin.bin_number}`.slice(0, 40),
          inventory: { items: inventoryLines },
        });
      }
```

Add `destLocation` to the `handleSubmit` dependency array:

```jsx
  }, [submitting, movingItemsList, sourceBin, destBin, selectedLocation, destLocation, totalMoveScans]);
```

Also update the success-path activity log call inside `handleSubmit` to carry the location pair when cross-location:

```jsx
        logActivity({
          module: "bin-transfer",
          action: "bin-transfer-completed",
          status: "success",
          sourceDocument: isCrossLocation
            ? `${sourceBin.bin_number} @ ${selectedLocation.name} → ${destBin.bin_number} @ ${destLocation.name}`
            : `${sourceBin.bin_number} → ${destBin.bin_number}`,
          details: `${selectedLocation.name}: ${movingItemsList.length} items, ${totalMoveScans} units`,
          items: movingItemsList.map(i => ({ sku: i.sku, name: i.item_name, qty: i.move_qty })),
        });
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
npx vitest run src/modules/BinTransfer.crossLocation.test.jsx
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinTransfer.jsx src/modules/BinTransfer.crossLocation.test.jsx
git commit -m "feat: cross-location Bin Transfer posts a one-step inventory transfer"
```

### Task 1.4: Review-screen locations, resume restore, and state resets

**Files:**
- Modify: `src/modules/BinTransfer.crossLocation.test.jsx`
- Modify: `src/modules/BinTransfer.jsx`

- [ ] **Step 1: Write the failing tests**

Append:

```jsx
describe("review screen and session", () => {
  it("shows both locations on review when they differ", async () => {
    const input = renderDestScreen();
    fireEvent.click(screen.getByRole("button", { name: "Sales Floor" }));
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    expect(screen.getByText("@ Warehouse")).toBeTruthy();
    expect(screen.getByText("@ Sales Floor")).toBeTruthy();
  });

  it("resume restores a saved destLocation", async () => {
    const input = renderDestScreen({ ...destSession, destLocation: LOC_SF });
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    expect(suiteqlQueries().pop()).toContain("location = 3");
  });
});
```

- [ ] **Step 2: Run, verify the review-locations test fails**

```bash
npx vitest run src/modules/BinTransfer.crossLocation.test.jsx
```

Expected: `@ Warehouse` not found → FAIL. The resume test should already pass (restore landed in Task 1.1); if it fails, fix `handleResume`/`saveSession`.

- [ ] **Step 3: Implement review display and resets**

**3a.** In the review phase's From/To card (lines 715–730), show the location under each bin when locations differ, and drop the old single-location footer in that case:

```jsx
            {(() => {
              const cross = destLocation && String(destLocation.id) !== String(selectedLocation.id);
              return (
                <div style={{ ...S.card, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                    <div>
                      <div style={S.lbl}>From</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0", ...mono }}>{sourceBin?.bin_number}</div>
                      {cross && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>@ {selectedLocation?.name}</div>}
                    </div>
                    <div style={{ fontSize: 24, color: "#475569", alignSelf: "center" }}>→</div>
                    <div style={{ textAlign: "right" }}>
                      <div style={S.lbl}>To</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: ACCENT, ...mono }}>{destBin?.bin_number}</div>
                      {cross && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>@ {destLocation?.name}</div>}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>
                    {cross ? `${selectedLocation?.name} → ${destLocation?.name}` : `at ${selectedLocation?.name}`}
                  </div>
                </div>
              );
            })()}
```

**3b.** Reset `destLocation` everywhere the flow restarts, so a stale destination never leaks into the next transfer. Add `setDestLocation(null);` alongside the existing `setDestBin(null);` in each of:

- `startNewTransfer` (lines 345–355)
- the "Change Source Bin" button handler in the `scan-items` phase (lines 626–635 — this one clears source state; add both `setDestBin(null)` and `setDestLocation(null)` for symmetry)
- the review screen's "Cancel" button handler (lines 779–786)

(`handleSourceBinScan`'s success path already calls `setDestBin(null)` — add `setDestLocation(null)` there too, line 156.)

- [ ] **Step 4: Run the full suite**

```bash
npx vitest run
```

Expected: all files pass, including the pre-existing `_bins.test.js`, `_split-fulfill.test.js`, and `ItemReceipts.notOnPO.test.jsx`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinTransfer.jsx src/modules/BinTransfer.crossLocation.test.jsx
git commit -m "feat: cross-location review display + destLocation session lifecycle"
```

---

## Phase 2 — Live End-to-End Verification

### Task 2.1: Real device/browser run against live NetSuite

- [ ] **Step 1: Build and load the app**

Deploy (or `vercel dev`) and open the app. Enter Bin Transfer.

- [ ] **Step 2: Same-location regression check**

Do a small real same-location transfer (1 unit). Confirm the flow is unchanged and the bin transfer record appears in NetSuite.

- [ ] **Step 3: Cross-location transfer**

Move 1 unit from a backroom bin to a Sales Floor bin (or reverse whatever direction was used in the probe). Confirm:

- "To Location" chips render and default to the source location.
- Dest bin validates against the chosen location (try a bin that only exists at the source → must error with `Bin not found at <dest>`).
- Review shows `@ <source>` / `@ <dest>`.
- NetSuite shows the Inventory Transfer record; SuiteQL (Task 0.2 Step 3 query) shows the stock moved.

- [ ] **Step 4: Reverse the test move**

Run the transfer back through the app itself (dest → source) — this doubles as a second live pass.

- [ ] **Step 5: Commit any fixes; final full test run**

```bash
npx vitest run
```

Expected: all pass.

---

## Self-Review Notes

- **Spec coverage:** To Location selector + defaulting (Task 1.1) ↔ spec §User Flow 4; validation/rejection rules (Tasks 1.1–1.2) ↔ spec §User Flow 4; submit branch + payload (Task 1.3) ↔ spec §NetSuite Write; review display, session, activity log (Tasks 1.3–1.4) ↔ spec §User Flow 5, §State & Session; probes (Phase 0) ↔ spec §Pre-Implementation Verification; live run (Phase 2) covers §Error Handling's unchanged model implicitly (submit failure path untouched).
- **Location-change-clears-bin:** spec's rule "changing To Location clears the scanned destination bin" is implemented in the chip `onClick` (`setDestBin(null)`, Task 1.1 Step 3e); it's structurally unreachable with a stale bin in normal flow (scanning a bin advances to review), so no dedicated test — the chip handler covers it.
- **Field-name risk** is isolated: Task 0.2 proves the exact `inventorytransfer` payload against the live account before any of Phase 1 hardcodes it, and Tasks 1.3's tests/impl both note to substitute proven names.
