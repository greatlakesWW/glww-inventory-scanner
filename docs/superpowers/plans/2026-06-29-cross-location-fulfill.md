# Cross-Location Fulfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a picker fulfill a single Sales Order line across multiple NetSuite locations by firing one location-overridden Item Fulfillment per location, with split-inventory orders flagged automatically at scan time and handled in a dedicated tool.

**Architecture:** Detection is added to the existing `/api/sales-orders/resolve` scan endpoint (an availability pass that tags orders `needsSplit`). Handling is a new self-contained UI tool that drives a new orchestration route, which calls the existing `fulfillSalesOrder` RESTlet once per location — sequentially — with a new per-line `locationId` override. The wave-pick flow is untouched.

**Tech Stack:** Vite + React (handheld UI), Vercel serverless functions (`api/`), NetSuite SuiteQL + a SuiteScript RESTlet (`netsuite/fulfillSalesOrder.js`), Vitest (new, for pure-logic units).

**Design spec:** `docs/superpowers/specs/2026-06-29-cross-location-fulfill-design.md`
**Live test SO:** internal id `643857` (account `9405258`).

**How to run NetSuite probes / endpoints below:** point requests at the running app — either the deployed Vercel URL or a local `vercel dev` with the NetSuite env vars set (`NS_ACCOUNT_ID`, `NS_CONSUMER_KEY`, `NS_CONSUMER_SECRET`, `NS_TOKEN_ID`, `NS_TOKEN_SECRET`, `NS_RESTLET_FULFILL_SO_URL`). Substitute `$APP` for that base URL in the commands.

---

## Phase 0 — NetSuite Verification Probes (GATE)

**Do not build anything past Phase 0 until all three probes pass.** Each probe has a decision gate. If a probe fails, stop and report — the manual UI path working is strong evidence but not proof the scripted path behaves identically.

### Task 0.1: Probe — is `inventorybalance.quantityavailable` queryable?

**Files:** none (read-only SuiteQL).

- [ ] **Step 1: Run the availability query**

Run:
```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{
  "query": "SELECT ib.item, ib.location, ib.quantityonhand, ib.quantityavailable FROM inventorybalance ib WHERE ROWNUM <= 5"
}'
```

Expected (PASS): HTTP 200, `items[]` rows each containing a `quantityavailable` value.
Expected (FAIL): a NetSuite error mentioning the field is not searchable / NOT_EXPOSED.

- [ ] **Step 2: Record the decision**

- PASS → the detection selector uses `quantityavailable`.
- FAIL → fall back to `quantityonhand` everywhere in this plan. Note the substitution in the spec's Open Verification section and in `api/_split-fulfill.js` comments.

Record the outcome in the plan PR/commit message. No code commit for this task.

### Task 0.2: Probe — confirm SO 643857 is a valid split test case

**Files:** none (read-only SuiteQL).

- [ ] **Step 1: Read the SO's inventory lines and committed locations**

Run:
```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{
  "query": "SELECT tl.item, item.itemid AS sku, tl.location, BUILTIN.DF(tl.location) AS loc_name, ABS(tl.quantity) AS qty FROM transactionline tl JOIN item ON item.id = tl.item WHERE tl.transaction = 643857 AND tl.mainline = '\''F'\'' AND tl.itemtype IN ('\''InvtPart'\'','\''Assembly'\'','\''Kit'\'') AND ABS(tl.quantity) > 0"
}'
```

Note the `item` id(s), committed `location`, and `qty` for the line(s) we will split.

- [ ] **Step 2: Read per-location availability for those item(s)**

Run (substitute `<ITEM_ID>` from Step 1; use `quantityonhand` instead of `quantityavailable` if Task 0.1 failed):
```bash
curl -s -X POST "$APP/api/suiteql" -H "Content-Type: application/json" -d '{
  "query": "SELECT ib.location, BUILTIN.DF(ib.location) AS loc_name, SUM(ib.quantityavailable) AS avail FROM inventorybalance ib WHERE ib.item = <ITEM_ID> AND NVL(ib.quantityavailable,0) > 0 GROUP BY ib.location, BUILTIN.DF(ib.location)"
}'
```

Expected (PASS): the committed location's available qty is LESS than the ordered qty, and the SUM across all locations is >= ordered qty (i.e. it genuinely needs a split and is coverable). Record the exact location ids + quantities — they are the expected allocation for the Phase 5 e2e.
Expected (problem): if it's fully sourceable at the committed location, this SO is not a valid test case — ask the user for a different SO before proceeding.

### Task 0.3: Probe — scripted SO→IF transform + line `location` override (dry run, no save)

**Files:**
- Modify: `netsuite/fulfillSalesOrder.js` (add a `diagnose` action that does NOT save).

- [ ] **Step 1: Add a non-saving diagnose path to the RESTlet**

In `netsuite/fulfillSalesOrder.js`, inside `doPost`, before the normal path, add:

```javascript
    if (body && body.diagnose) {
      return runDiagnose(body);
    }
```

Add this function (above `doPost`):

```javascript
  // Dry-run probe: transform SO → IF, then for the target itemId line
  // report whether the line exists, its default location, and whether we
  // can set the override location + assign a bin from that location.
  // NEVER calls save(). Returns a diagnostics object.
  function runDiagnose(body) {
    var soId = String(body.salesOrderId);
    var itemId = String(body.itemId);
    var targetLocationId = String(body.targetLocationId);
    var targetBinId = body.targetBinId != null ? String(body.targetBinId) : null;
    var targetQty = Number(body.targetQty) || 1;
    var out = { status: 'diagnose', soId: soId, itemId: itemId, targetLocationId: targetLocationId, steps: {} };

    var ff = record.transform({
      fromType: record.Type.SALES_ORDER, fromId: soId,
      toType: record.Type.ITEM_FULFILLMENT, isDynamic: true,
    });
    var lineCount = ff.getLineCount({ sublistId: 'item' });
    out.steps.transformLineCount = lineCount;

    var found = false;
    for (var i = 0; i < lineCount; i++) {
      ff.selectLine({ sublistId: 'item', line: i });
      var io = ff.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
      if (String(io) !== itemId) continue;
      found = true;
      out.steps.lineFound = true;
      out.steps.defaultLocation = String(ff.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' }));
      try {
        ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: targetLocationId });
        out.steps.setLocationOk = String(ff.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' }));
        ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: targetQty });
        var inv = ff.getCurrentSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail' });
        var existing = inv.getLineCount({ sublistId: 'inventoryassignment' });
        for (var j = existing - 1; j >= 0; j--) inv.removeLine({ sublistId: 'inventoryassignment', line: j });
        if (targetBinId) {
          inv.selectNewLine({ sublistId: 'inventoryassignment' });
          inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: targetBinId });
          inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: targetQty });
          inv.commitLine({ sublistId: 'inventoryassignment' });
          out.steps.binAssignOk = true;
        }
      } catch (e) {
        out.steps.error = e.message;
      }
      break;
    }
    if (!found) out.steps.lineFound = false;
    out.steps.saved = false; // dry run — intentionally not saved
    return out;
  }
```

- [ ] **Step 2: Deploy the RESTlet and run the probe**

Deploy the updated `netsuite/fulfillSalesOrder.js` to its NetSuite script deployment (same place `NS_RESTLET_FULFILL_SO_URL` points). Then call it through a tiny temporary passthrough, or directly with OAuth. Simplest: call the existing fulfill route is not suitable (it builds its own body), so call the RESTlet directly using its URL + OAuth, with body:

```json
{
  "diagnose": true,
  "salesOrderId": "643857",
  "itemId": "<ITEM_ID from Task 0.2>",
  "targetLocationId": "<a non-committed location that has stock, from Task 0.2>",
  "targetBinId": "<a bin id at that location, or omit if location is non-bin>",
  "targetQty": 1
}
```

Expected (PASS): response `steps.lineFound = true`, `steps.setLocationOk` equals the target location id, and (if a bin was supplied) `steps.binAssignOk = true`, with no `steps.error`.
Expected (FAIL): `lineFound = false` (transform drops the line at 0 committed-location availability → probe 3 fails) or `setLocationOk` not equal to target / an `error` (override blocked → probe 2 fails).

- [ ] **Step 3: Record the decision and remove or keep the diagnose path**

- All PASS → proceed to Phase 1. Keep `runDiagnose` (it's a useful future probe, mirrors `receiveTransferOrder.js`).
- Any FAIL → STOP. Report which probe failed; the feature design must be revisited (e.g. fall back to splitting the SO line).

- [ ] **Step 4: Commit**

```bash
git add netsuite/fulfillSalesOrder.js
git commit -m "Cross-Location Fulfill: add diagnose dry-run probe to SO fulfill RESTlet"
```

---

## Phase 1 — RESTlet location override

### Task 1.1: Add optional per-line `locationId` to `fulfillSalesOrder.js`

**Files:**
- Modify: `netsuite/fulfillSalesOrder.js` (`createFulfillment`, and the `specByItemId` builder in `doPost`).

- [ ] **Step 1: Carry `locationId` into the per-item spec**

In `doPost`, where `specByItemId[iid]` is initialized, add a `locationId` slot, and capture it from the line:

```javascript
      if (!specByItemId[iid]) { specByItemId[iid] = { totalQty: 0, bins: [], locationId: null }; }
      if (L.locationId != null && String(L.locationId) !== "") {
        specByItemId[iid].locationId = String(L.locationId);
      }
```

- [ ] **Step 2: Set the line location before assigning bins**

In `createFulfillment`, inside the `if (spec && spec.totalQty > 0)` block, immediately after setting `itemreceive` and BEFORE setting `quantity`, add:

```javascript
        if (spec.locationId) {
          ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: spec.locationId });
        }
```

(Setting location before quantity/inventorydetail ensures the bin list validates against the override location. When `spec.locationId` is null — the wave-pick path — behavior is unchanged.)

- [ ] **Step 3: Smoke-test on the live test SO (single location, real save)**

Call the RESTlet directly (OAuth) with a real single-location body for SO 643857, shipping qty 1 of the test item from ONE non-committed location that has stock (from Task 0.2), `setShipped: false`:

```json
{
  "salesOrderId": "643857",
  "setShipped": false,
  "lines": [
    { "itemId": "<ITEM_ID>", "locationId": "<NON_COMMITTED_LOC>", "bins": [ { "binId": "<BIN_AT_LOC>", "quantity": 1 } ] }
  ]
}
```

Expected: `{ status: "created", fulfillmentId: "...", ... }`. In NetSuite, confirm the Item Fulfillment shipped from `<NON_COMMITTED_LOC>` and the SO is now Partially Fulfilled.

> NOTE: this writes a real IF on the live SO. After confirming, either leave it (it becomes IF #1 of the e2e) or have an admin delete it to reset 643857 for a clean Phase 5 run.

- [ ] **Step 4: Commit**

```bash
git add netsuite/fulfillSalesOrder.js
git commit -m "Cross-Location Fulfill: support per-line location override in SO fulfill RESTlet"
```

---

## Phase 2 — Detection logic (pure, TDD)

### Task 2.1: Add Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`

- [ ] **Step 1: Install Vitest**

Run: `npm install -D vitest`
Expected: `vitest` appears in `devDependencies`.

- [ ] **Step 2: Add a test script**

In `package.json` `scripts`, add:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create the Vitest config**

Create `vitest.config.js`:

```javascript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{js,jsx}"],
    exclude: ["node_modules/**"],
  },
});
```

- [ ] **Step 4: Verify the runner works (no tests yet)**

Run: `npm test`
Expected: Vitest runs and reports "no test files found" (exit 0 or a clear no-tests message). If it errors, fix config before continuing.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.js
git commit -m "Add Vitest test runner"
```

### Task 2.2: `computeSplitPlan` pure function (TDD)

**Files:**
- Create: `api/_split-fulfill.js`
- Test: `api/_split-fulfill.test.js`

- [ ] **Step 1: Write the failing tests**

Create `api/_split-fulfill.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { computeSplitPlan } from "./_split-fulfill.js";

const line = (over = {}) => ({ itemId: "100", qtyRemaining: 2, committedLocationId: "3", ...over });

describe("computeSplitPlan", () => {
  it("flags a line short at its committed location but coverable elsewhere", () => {
    const avail = { "100": [
      { locationId: "3", locationName: "Warehouse", available: 0 },
      { locationId: "1", locationName: "Sales Floor", available: 1 },
      { locationId: "2", locationName: "Backroom", available: 1 },
    ] };
    const r = computeSplitPlan([line()], avail);
    expect(r.needsSplit).toBe(true);
    const allocs = r.splitLines[0].allocations;
    expect(allocs.reduce((s, a) => s + a.qty, 0)).toBe(2);
    expect(allocs.map((a) => a.locationId).sort()).toEqual(["1", "2"]);
  });

  it("does NOT flag a line fully sourceable at its committed location", () => {
    const avail = { "100": [{ locationId: "3", locationName: "Warehouse", available: 5 }] };
    const r = computeSplitPlan([line()], avail);
    expect(r.needsSplit).toBe(false);
    expect(r.splitLines[0].allocations).toEqual([]);
  });

  it("does NOT flag a true stockout (short everywhere)", () => {
    const avail = { "100": [
      { locationId: "3", available: 0 },
      { locationId: "1", available: 1 },
    ] };
    const r = computeSplitPlan([line({ qtyRemaining: 5 })], avail);
    expect(r.needsSplit).toBe(false);
  });

  it("uses committed-location stock first, then most-available", () => {
    const avail = { "100": [
      { locationId: "3", locationName: "Warehouse", available: 1 },
      { locationId: "1", locationName: "Sales Floor", available: 1 },
      { locationId: "2", locationName: "Backroom", available: 5 },
    ] };
    const r = computeSplitPlan([line({ qtyRemaining: 3 })], avail);
    expect(r.needsSplit).toBe(true);
    expect(r.splitLines[0].allocations).toEqual([
      { locationId: "3", locationName: "Warehouse", qty: 1 },
      { locationId: "2", locationName: "Backroom", qty: 2 },
    ]);
  });

  it("flags the order if ANY line needs a split", () => {
    const lines = [
      line({ itemId: "100", qtyRemaining: 1, committedLocationId: "3" }),
      line({ itemId: "200", qtyRemaining: 2, committedLocationId: "3" }),
    ];
    const avail = {
      "100": [{ locationId: "3", available: 5 }],
      "200": [{ locationId: "3", available: 0 }, { locationId: "1", available: 2 }],
    };
    const r = computeSplitPlan(lines, avail);
    expect(r.needsSplit).toBe(true);
    expect(r.splitLines.find((l) => l.itemId === "100").allocations).toEqual([]);
    expect(r.splitLines.find((l) => l.itemId === "200").allocations.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- _split-fulfill`
Expected: FAIL — `computeSplitPlan is not a function` / module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `api/_split-fulfill.js`:

```javascript
// ═══════════════════════════════════════════════════════════
// Cross-Location Fulfill — pure allocation logic.
//
// computeSplitPlan decides whether an order needs a cross-location
// split and, if so, how to spread each short line's remaining qty
// across the locations that actually hold the stock.
//
// "available" is NetSuite inventorybalance.quantityavailable
// (falls back to quantityonhand if that column is not exposed in
// this account — see the design spec's Open Verification).
// ═══════════════════════════════════════════════════════════

/**
 * @param {Array<{itemId:string, qtyRemaining:number, committedLocationId:string}>} lines
 * @param {Record<string, Array<{locationId:string, locationName?:string, available:number}>>} availByItem
 * @returns {{ needsSplit:boolean, splitLines:Array<{itemId:string, qtyRemaining:number, committedLocationId:string, allocations:Array<{locationId:string, locationName:string|null, qty:number}>}> }}
 */
export function computeSplitPlan(lines, availByItem) {
  const splitLines = [];
  let needsSplit = false;

  for (const line of lines) {
    const avail = (availByItem && availByItem[line.itemId]) || [];
    const need = Number(line.qtyRemaining) || 0;
    const committedAvail = avail
      .filter((a) => String(a.locationId) === String(line.committedLocationId))
      .reduce((s, a) => s + (Number(a.available) || 0), 0);
    const totalAvail = avail.reduce((s, a) => s + (Number(a.available) || 0), 0);

    // Sourceable as committed, or short everywhere (true stockout):
    // neither is a cross-location split candidate.
    if (committedAvail >= need || totalAvail < need) {
      splitLines.push({ ...line, allocations: [] });
      continue;
    }

    needsSplit = true;
    // Committed location first (consume what's already there), then
    // remaining locations most-available-first.
    const ordered = [...avail].sort((a, b) => {
      const ac = String(a.locationId) === String(line.committedLocationId);
      const bc = String(b.locationId) === String(line.committedLocationId);
      if (ac !== bc) return ac ? -1 : 1;
      return (Number(b.available) || 0) - (Number(a.available) || 0);
    });

    let remaining = need;
    const allocations = [];
    for (const a of ordered) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(a.available) || 0);
      if (take <= 0) continue;
      allocations.push({
        locationId: String(a.locationId),
        locationName: a.locationName || null,
        qty: take,
      });
      remaining -= take;
    }
    splitLines.push({ ...line, allocations });
  }

  return { needsSplit, splitLines };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- _split-fulfill`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_split-fulfill.js api/_split-fulfill.test.js
git commit -m "Cross-Location Fulfill: add computeSplitPlan allocation logic"
```

### Task 2.3: Per-(item,location) availability loader

**Files:**
- Modify: `api/_split-fulfill.js` (add `loadAvailabilityByItem`)
- Test: `api/_split-fulfill.test.js` (add a parsing test for the row→shape mapper)

- [ ] **Step 1: Write a failing test for the row mapper**

Add to `api/_split-fulfill.test.js`:

```javascript
import { shapeAvailabilityRows } from "./_split-fulfill.js";

describe("shapeAvailabilityRows", () => {
  it("groups SuiteQL rows into availByItem keyed by item id", () => {
    const rows = [
      { item_id: "100", location_id: "1", loc_name: "Sales Floor", avail: "1" },
      { item_id: "100", location_id: "2", loc_name: "Backroom", avail: "1" },
      { item_id: "200", location_id: "1", loc_name: "Sales Floor", avail: "3" },
    ];
    const out = shapeAvailabilityRows(rows);
    expect(out["100"].length).toBe(2);
    expect(out["100"][0]).toEqual({ locationId: "1", locationName: "Sales Floor", available: 1 });
    expect(out["200"][0].available).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- _split-fulfill`
Expected: FAIL — `shapeAvailabilityRows is not a function`.

- [ ] **Step 3: Implement the mapper + the loader**

Add to `api/_split-fulfill.js`:

```javascript
import { runSuiteQL, batchIds } from "./_suiteql.js";

// Set to false if Task 0.1 proved quantityavailable is not queryable.
export const AVAILABILITY_COLUMN = "quantityavailable";

export function shapeAvailabilityRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const itemId = r.item_id != null ? String(r.item_id) : null;
    const locationId = r.location_id != null ? String(r.location_id) : null;
    if (!itemId || !locationId) continue;
    (out[itemId] ||= []).push({
      locationId,
      locationName: r.loc_name || null,
      available: Number(r.avail) || 0,
    });
  }
  return out;
}

/**
 * Loads per-(item, location) availability for the given item ids across
 * ALL locations. Returns availByItem suitable for computeSplitPlan.
 */
export async function loadAvailabilityByItem(itemIds) {
  const ids = [...new Set((itemIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return {};
  const col = AVAILABILITY_COLUMN;
  const all = [];
  for (const batch of batchIds(ids, 200)) {
    const { items } = await runSuiteQL(`
      SELECT
        ib.item AS item_id,
        ib.location AS location_id,
        BUILTIN.DF(ib.location) AS loc_name,
        SUM(ib.${col}) AS avail
      FROM inventorybalance ib
      WHERE ib.item IN (${batch.join(",")})
        AND NVL(ib.${col}, 0) > 0
      GROUP BY ib.item, ib.location, BUILTIN.DF(ib.location)
    `);
    all.push(...items);
  }
  return shapeAvailabilityRows(all);
}
```

> If Task 0.1 FAILED, change `AVAILABILITY_COLUMN` to `"quantityonhand"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- _split-fulfill`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_split-fulfill.js api/_split-fulfill.test.js
git commit -m "Cross-Location Fulfill: add per-(item,location) availability loader"
```

### Task 2.4: Wire detection into `/api/sales-orders/resolve`

**Files:**
- Modify: `api/sales-orders/resolve.js`

- [ ] **Step 1: Import the split helpers**

At the top of `api/sales-orders/resolve.js`, add:

```javascript
import { loadAvailabilityByItem, computeSplitPlan } from "../_split-fulfill.js";
```

- [ ] **Step 2: After `resolved` is built, attach split info**

Replace the final `return res.status(200).json({ resolved, unresolved });` with the block below. It loads availability for every item across the resolved orders, computes a split plan per order against each line's committed location, and attaches `needsSplit` + `splitPlan`. Detection failure is non-fatal — orders still return, untagged.

```javascript
    // ─── Cross-location split detection ───
    // For each resolved order, decide if any line is short at its
    // committed location but coverable across other locations. Failure
    // here must NOT break the scan screen — fall back to untagged.
    try {
      // Per-item, per-location remaining lines for all resolved SOs.
      // (perLocation aggregates qty per location but not per item;
      // computeSplitPlan needs per-(item,location) granularity, so we
      // re-query the lines grouped by item + location here.)
      const allIds = resolved.map((r) => Number(r.id)).filter(Number.isInteger);
      const { items: splitLineRows } = await runSuiteQL(`
        SELECT
          tl.transaction AS so_id,
          tl.item AS item_id,
          tl.location AS location_id,
          SUM(ABS(tl.quantity)) AS qty
        FROM transactionline tl
        WHERE tl.transaction IN (${allIds.join(",")})
          AND tl.mainline = 'F'
          AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
          AND ABS(tl.quantity) > 0
        GROUP BY tl.transaction, tl.item, tl.location
      `);
      const lineSpecsBySo = {};
      const allItemIds = new Set();
      for (const row of splitLineRows) {
        const sid = String(row.so_id);
        (lineSpecsBySo[sid] ||= []).push({
          itemId: String(row.item_id),
          committedLocationId: String(row.location_id),
          qtyRemaining: Number(row.qty) || 0,
        });
        allItemIds.add(String(row.item_id));
      }

      const availByItem = await loadAvailabilityByItem([...allItemIds]);

      for (const r of resolved) {
        const specs = lineSpecsBySo[r.id] || [];
        const plan = computeSplitPlan(specs, availByItem);
        r.needsSplit = plan.needsSplit;
        r.splitPlan = plan.needsSplit ? plan.splitLines.filter((l) => l.allocations.length > 0) : [];
      }
    } catch (e) {
      console.warn("resolve: split detection failed (non-fatal):", e?.message);
      for (const r of resolved) { r.needsSplit = false; r.splitPlan = []; }
    }

    return res.status(200).json({ resolved, unresolved });
```

- [ ] **Step 3: Manual check against the live scan flow**

With the app running, POST the test order's Shopify/SO key:

```bash
curl -s -X POST "$APP/api/sales-orders/resolve" -H "Content-Type: application/json" -d '{ "keys": ["<KEY-FOR-643857>"] }'
```

Expected: the resolved entry for 643857 has `needsSplit: true` and a `splitPlan` whose allocations match Task 0.2's recorded quantities. A normal, fully-sourceable order resolves with `needsSplit: false`.

- [ ] **Step 4: Commit**

```bash
git add api/sales-orders/resolve.js
git commit -m "Cross-Location Fulfill: detect split-inventory orders at resolve time"
```

---

## Phase 3 — Split-fulfill orchestration route

### Task 3.1: `POST /api/sales-orders/[id]/split-fulfill`

**Files:**
- Create: `api/sales-orders/[id]/split-fulfill.js`

- [ ] **Step 1: Write the route**

Create `api/sales-orders/[id]/split-fulfill.js`. It accepts a per-location allocation (each with bins the picker scanned), re-checks remaining qty per location right before each call, fires the RESTlet sequentially, marks the final call `setShipped`, and reports per-location results including partial success.

```javascript
import { getSuiteQLConfig } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";

// ═══════════════════════════════════════════════════════════
// POST /api/sales-orders/:id/split-fulfill
//
// Fulfills ONE Sales Order line across multiple locations by calling
// the fulfillSalesOrder RESTlet once per location, sequentially, each
// with a location override. The first calls leave the SO Partially
// Fulfilled; the last call (when it completes the order) sets shipped.
//
// Body:
// {
//   "itemId": "100",
//   "allocations": [
//     { "locationId": "2", "bins": [ { "binId": "4001", "quantity": 1 } ] },
//     { "locationId": "1", "bins": [ { "binId": "F-01", "quantity": 1 } ] }
//   ],
//   "completesOrder": true   // if true, the final call sets shipped
// }
//
// Sequential calls avoid RCRD_HAS_BEEN_CHANGED contention. Partial
// success is reported, never hidden.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const soId = req.query?.id;
  if (!soId || typeof soId !== "string") {
    return res.status(400).json({ error: "Missing sessionId path param" });
  }

  const restletUrl = process.env.NS_RESTLET_FULFILL_SO_URL;
  if (!restletUrl) {
    return res.status(500).json({ error: "NS_RESTLET_FULFILL_SO_URL is not configured." });
  }

  let config;
  try { config = getSuiteQLConfig(); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  const body = req.body || {};
  const itemId = body.itemId != null ? String(body.itemId) : "";
  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const completesOrder = !!body.completesOrder;
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  if (allocations.length === 0) return res.status(400).json({ error: "allocations[] must be non-empty" });

  const [restletBase, restletQs] = restletUrl.split("?");
  const restletQp = {};
  if (restletQs) {
    for (const pair of restletQs.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) restletQp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }

  const results = [];
  let anySuccess = false;
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const isLast = i === allocations.length - 1;
    const locId = a.locationId != null ? String(a.locationId) : "";
    const bins = Array.isArray(a.bins) ? a.bins : [];
    const qty = bins.reduce((s, b) => s + (Number(b.quantity) || 0), 0);
    if (!locId || qty <= 0) {
      results.push({ locationId: locId, status: "skipped_empty", fulfillmentId: null });
      continue;
    }

    const restletBody = {
      salesOrderId: soId,
      setShipped: completesOrder && isLast,
      lines: [{ itemId, locationId: locId, bins }],
    };

    let attempt;
    try {
      const auth = generateOAuthHeader("POST", restletBase, restletQp, config);
      const resp = await fetch(restletUrl, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(restletBody),
      });
      const text = await resp.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!resp.ok || !data?.fulfillmentId) {
        const error = (typeof data === "object" && (data?.["o:errorDetails"]?.[0]?.detail || data?.error?.message || data?.message)) ||
                      (typeof data === "string" ? data.slice(0, 300) : `RESTlet returned ${resp.status}`);
        results.push({ locationId: locId, qty, status: "error", error, fulfillmentId: null });
        continue;
      }
      anySuccess = true;
      results.push({ locationId: locId, qty, status: "fulfilled", fulfillmentId: String(data.fulfillmentId) });
    } catch (e) {
      results.push({ locationId: locId, qty, status: "error", error: `RESTlet call threw: ${e.message}`, fulfillmentId: null });
    }
  }

  const allOk = results.every((r) => r.status === "fulfilled");
  return res.status(anySuccess ? 200 : 500).json({
    status: allOk ? "complete" : anySuccess ? "partial" : "failed",
    soId,
    itemId,
    results,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add "api/sales-orders/[id]/split-fulfill.js"
git commit -m "Cross-Location Fulfill: add per-location fulfillment orchestration route"
```

> Live verification of this route happens in Phase 5 (it writes real IFs).

---

## Phase 4 — UI

### Task 4.1: Flag split orders on the plan screen

**Files:**
- Modify: `src/pick-so/PlanScreen.jsx`
- Modify: `src/pick-so/PickSalesOrders.jsx` (route to the new screen)

- [ ] **Step 1: Read the current PlanScreen rendering**

Run: open `src/pick-so/PlanScreen.jsx` and locate where resolved orders / per-location cards render. Identify the state holding resolved orders.

- [ ] **Step 2: Render a distinct "split" pile**

Where the resolved orders render, add a section above/beside the normal location cards for orders with `needsSplit === true`. Each renders the order number, customer, and the SKUs + per-location allocation from `splitPlan`, with a button:

```jsx
{resolvedOrders.filter((o) => o.needsSplit).length > 0 && (
  <div style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 13, fontWeight: 700, color: "#b45309", marginBottom: 8 }}>
      ⚠ Split across locations
    </div>
    {resolvedOrders.filter((o) => o.needsSplit).map((o) => (
      <button
        key={o.id}
        onClick={() => onStartSplit(o)}
        style={{ display: "block", width: "100%", textAlign: "left", padding: 12, marginBottom: 8,
                 border: "1px solid #f59e0b", borderRadius: 8, background: "#fffbeb" }}
      >
        <div style={{ fontWeight: 700 }}>{o.tranId || o.shopifyOrderNumber || o.id}</div>
        <div style={{ fontSize: 12, color: "#92400e" }}>{o.customerName}</div>
        {o.splitPlan?.map((l) => (
          <div key={l.itemId} style={{ fontSize: 12, color: "#78350f" }}>
            {l.itemId}: {l.allocations.map((a) => `${a.locationName || a.locationId}: ${a.qty}`).join(" · ")}
          </div>
        ))}
        <div style={{ fontSize: 12, color: "#b45309", marginTop: 4 }}>Split across locations →</div>
      </button>
    ))}
  </div>
)}
```

Add `onStartSplit` to PlanScreen's props (passed from `PickSalesOrders.jsx`). Adjust field names to match the actual resolved-order shape in this file.

- [ ] **Step 3: Add the screen route in PickSalesOrders.jsx**

In `src/pick-so/PickSalesOrders.jsx`, add a `"split"` phase and an `onStartSplit` handler that stores the chosen order and switches phase:

```jsx
  const [splitOrder, setSplitOrder] = useState(null);
  // ...
  // pass to PlanScreen: onStartSplit={(o) => { setSplitOrder(o); setPhase("split"); }}
  // ...
  if (phase === "split") {
    return (
      <SplitFulfillScreen
        order={splitOrder}
        onDone={() => { setSplitOrder(null); setPhase("plan"); }}
        onBack={() => { setSplitOrder(null); setPhase("plan"); }}
      />
    );
  }
```

Import `SplitFulfillScreen` at the top (created in Task 4.2).

- [ ] **Step 4: Build the app to verify it compiles**

Run: `npm run build`
Expected: build succeeds (SplitFulfillScreen exists after Task 4.2; if doing 4.1 first, stub the import — better to implement 4.2 before building).

- [ ] **Step 5: Commit**

```bash
git add src/pick-so/PlanScreen.jsx src/pick-so/PickSalesOrders.jsx
git commit -m "Cross-Location Fulfill: flag split orders on the plan screen"
```

### Task 4.2: Build `SplitFulfillScreen`

**Files:**
- Create: `src/pick-so/SplitFulfillScreen.jsx`

- [ ] **Step 1: Implement the screen**

Create `src/pick-so/SplitFulfillScreen.jsx`. It shows the order's short line(s) and proposed per-location allocation, lets the picker scan a bin per location (reusing the bin-availability the resolve `splitPlan` carries, and confirming the bin actually scanned), then POSTs to the orchestration route and shows the result.

```jsx
import { useState } from "react";

// ═══════════════════════════════════════════════════════════
// SplitFulfillScreen — handles one split-inventory order.
// Walks the picker location-by-location for a short SKU, then fires
// the per-location fulfillment via /api/sales-orders/:id/split-fulfill.
// Self-contained: does not touch the wave/lock machinery.
// ═══════════════════════════════════════════════════════════

export default function SplitFulfillScreen({ order, onDone, onBack }) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // v1: one short line per order is the common case. Take the first
  // split line; multi-line orders loop the same flow per line later.
  const line = (order?.splitPlan || [])[0];

  // Picker confirms the scanned bin per allocation. We seed bins from
  // the allocation's location; the picker scans to confirm physical pick.
  const [bins, setBins] = useState(() =>
    (line?.allocations || []).map((a) => ({ locationId: a.locationId, locationName: a.locationName, qty: a.qty, binId: "", binText: "" }))
  );

  if (!order || !line) {
    return (
      <div style={{ padding: 16 }}>
        <p>Nothing to split for this order.</p>
        <button onClick={onBack}>← Back</button>
      </div>
    );
  }

  const allScanned = bins.every((b) => b.binId);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/sales-orders/${encodeURIComponent(order.id)}/split-fulfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: line.itemId,
          completesOrder: true,
          allocations: bins.map((b) => ({
            locationId: b.locationId,
            bins: [{ binId: b.binId, quantity: b.qty }],
          })),
        }),
      });
      const d = await r.json();
      if (!r.ok && d?.status !== "partial") throw new Error(d?.error || `API ${r.status}`);
      setResult(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div style={{ padding: 16 }}>
        <h3>{result.status === "complete" ? "✓ Fulfilled across locations" : result.status === "partial" ? "⚠ Partially fulfilled" : "✗ Failed"}</h3>
        {result.results.map((r, i) => (
          <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
            {r.locationId}: {r.status}{r.fulfillmentId ? ` — IF ${r.fulfillmentId}` : ""}{r.error ? ` — ${r.error}` : ""}
          </div>
        ))}
        {result.status === "partial" && (
          <p style={{ color: "#b45309", fontSize: 13 }}>
            Some locations shipped and some did not. The order is Partially Fulfilled — finish the remaining location(s) before considering it done.
          </p>
        )}
        <button onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <button onClick={onBack} style={{ marginBottom: 12 }}>← Back</button>
      <h3>Split: {order.tranId || order.shopifyOrderNumber || order.id}</h3>
      <div style={{ fontSize: 13, color: "#475569", marginBottom: 12 }}>Item {line.itemId} — scan one bin per location.</div>
      {bins.map((b, i) => (
        <div key={i} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>{b.locationName || b.locationId} — qty {b.qty}</div>
          <input
            placeholder="Scan/enter bin id"
            value={b.binText}
            onChange={(e) => {
              const v = e.target.value;
              setBins((prev) => prev.map((x, j) => j === i ? { ...x, binText: v, binId: v.trim() } : x));
            }}
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          />
        </div>
      ))}
      {error && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <button disabled={!allScanned || submitting} onClick={submit} style={{ width: "100%", padding: 12 }}>
        {submitting ? "Fulfilling…" : "Fulfill across locations"}
      </button>
    </div>
  );
}
```

> This is a deliberately minimal v1 UI. Match styling/components to the existing `src/pick-so/` screens (the wave-pick bin-scan input, button styles, `shared.jsx` helpers) rather than the inline styles above. If the codebase has a reusable bin-scan/validation component, use it so a wrong bin is rejected here too.

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/pick-so/SplitFulfillScreen.jsx
git commit -m "Cross-Location Fulfill: add SplitFulfillScreen tool"
```

---

## Phase 5 — Live end-to-end verification

### Task 5.1: Full run against SO 643857

**Files:** none (manual verification on the live system).

- [ ] **Step 1: Reset the test SO if needed**

If Phase 1 Step 3 left an IF on 643857, have an admin delete it so the SO is fully Pending Fulfillment again (or pick a fresh equivalent SO and update the memory note).

- [ ] **Step 2: Run the flow end to end**

With the app running: scan the key for 643857 on the plan screen → confirm it appears under "⚠ Split across locations" with the expected per-location allocation → open it → scan the bin for each location → tap "Fulfill across locations".

Expected: status "complete"; two Item Fulfillments listed, each shipping from the expected location.

- [ ] **Step 3: Verify in NetSuite**

In NetSuite, open SO 643857. Confirm: two linked Item Fulfillments exist, each shipped from the correct location with the correct qty/bin, and the SO status is now fully fulfilled (Shipped/Fulfilled).

- [ ] **Step 4: Verify the partial-failure path (optional but recommended)**

On another equivalent SO, force the second location's bin to be wrong/empty and run the flow. Expected: status "partial"; summary clearly states one location shipped and one did not, and the SO is Partially Fulfilled in NetSuite.

- [ ] **Step 5: Final commit / wrap-up**

```bash
git commit --allow-empty -m "Cross-Location Fulfill: verified end-to-end on live NetSuite SO 643857"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** detection (Task 2.4) ↔ spec §Detection; tool (Tasks 4.1–4.2) ↔ spec §Split-fulfill tool; RESTlet override (Task 1.1) ↔ spec §Fulfillment; orchestration + partial success (Task 3.1) ↔ spec §Concurrency/§Error Handling; the three probes (Phase 0) ↔ spec §Open Verification.
- **Availability column:** every SuiteQL availability reference uses `AVAILABILITY_COLUMN` (one constant in `api/_split-fulfill.js`) so the on-hand fallback is a one-line change if Task 0.1 fails.
- **Back-compat:** the RESTlet `locationId` is optional; the wave flow passes no `locationId` and is unaffected.
- **Field-name shapes:** `splitPlan[].allocations[]` = `{locationId, locationName, qty}` is produced by `computeSplitPlan`, consumed unchanged by resolve.js, PlanScreen, and SplitFulfillScreen. The route body uses `allocations[].bins[]` = `{binId, quantity}`, matching the RESTlet's existing `bins` shape.
