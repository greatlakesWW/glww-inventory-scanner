# Bin Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a warehouse employee scan a bin barcode and immediately see every item in that bin, grouped by item class.

**Architecture:** One new read-only React module, `src/modules/BinLookup.jsx`, following the same client-queries-NetSuite pattern as every other lookup module in this app. Per scan it makes exactly two calls: the existing `GET /api/bins/validate` to resolve the bin number to an internal ID (which is what makes "bin doesn't exist" distinguishable from "bin is empty"), then `suiteqlAll` against `inventorybalance` for the contents. Grouping logic lives in a separate pure module so it can be unit tested without a DOM.

**Tech Stack:** React 18, Vite, Vitest + @testing-library/react, NetSuite SuiteQL via `/api/suiteql`.

**Spec:** `docs/superpowers/specs/2026-08-27-bin-lookup-design.md`

---

## Background You Need

**This is a handheld app.** It runs as a Chrome PWA on a Munbyn IPDA101, a 5.5" Android scanner gun. The gun types the barcode into the focused input and sends Enter. That is why every scan input in this codebase is a `ScanInput` from `src/shared.jsx` — it handles the Enter key, clears itself, refocuses, and queues rapid scans.

**Styling is inline objects, not CSS files.** `src/shared.jsx` exports a style object `S` (`S.root`, `S.card`, `S.hdr`, `S.btn`, `S.btnSm`, `S.btnSec`, `S.err`), a `mono` font object, and `FONT` / `ANIMATIONS` style strings that each screen injects with `<style>{FONT}{ANIMATIONS}</style>`. Follow that. Do not add a CSS file or a styling library.

**`suiteql` vs `suiteqlAll`.** `suiteql(query, limit=1000)` returns one page. `suiteqlAll(query, onProgress)` pages until exhausted. Sales Floor catch-all bins hold thousands of SKUs, so bin contents MUST use `suiteqlAll`. Using `suiteql` here is a silent data-loss bug, not a style preference.

**Bin numbers are only unique per location.** The same bin number can exist at Warehouse and at Sales Floor. Every bin query is scoped by location. `api/_bins.js` holds the canonical resolver and `GET /api/bins/validate?locationId=&binNumber=` exposes it. Do not write new bin-resolution SQL in the frontend.

**Tests.** `npm test` runs `vitest run`. The vitest environment defaults to `node`; component tests opt into a DOM with a `// @vitest-environment jsdom` comment on line 1. `@testing-library/jest-dom` is NOT installed — assert with `expect(...).toBeTruthy()` and `expect(...).toBeNull()`, never `toBeInTheDocument()`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/binLookupGrouping.js` | **Create.** Pure functions: `groupByClass(rows)`, `shouldAutoExpand(skuCount)`, `AUTO_EXPAND_MAX_SKUS`. No React, no DOM. |
| `src/modules/binLookupGrouping.test.js` | **Create.** Node-environment unit tests for the above. |
| `src/modules/BinLookup.jsx` | **Create.** The screen: location picker, bin scan, grouped results, item drawer. |
| `src/modules/BinLookup.test.jsx` | **Create.** jsdom component tests. |
| `src/App.jsx` | **Modify.** Import and route `"bin-lookup"`. |
| `src/Home.jsx` | **Modify.** Add the Bin Lookup utility bar under Item Lookup. |
| `src/modules/ActivityLog.jsx` | **Modify.** Register the `bin-lookup` module and action so log entries are filterable and labelled. |

---

## Task 1: Grouping helpers

Pure logic first, so the interesting rules are pinned down before any UI exists.

**Files:**
- Create: `src/modules/binLookupGrouping.js`
- Test: `src/modules/binLookupGrouping.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/binLookupGrouping.test.js`:

```js
import { describe, it, expect } from "vitest";
import { groupByClass, shouldAutoExpand, AUTO_EXPAND_MAX_SKUS } from "./binLookupGrouping";

const row = (sku, class_name, qty) => ({
  item_id: sku, sku, item_name: `${sku} name`, class_name,
  qty_on_hand: qty, qty_available: qty,
});

describe("groupByClass", () => {
  it("returns an empty array for no rows", () => {
    expect(groupByClass([])).toEqual([]);
    expect(groupByClass(undefined)).toEqual([]);
  });

  it("groups rows by class and counts SKUs and units", () => {
    const groups = groupByClass([
      row("A-1", "Pants", 3),
      row("A-2", "Pants", 4),
      row("B-1", "Gloves", 10),
    ]);
    expect(groups.map(g => g.className)).toEqual(["Gloves", "Pants"]);
    const pants = groups.find(g => g.className === "Pants");
    expect(pants.skuCount).toBe(2);
    expect(pants.unitCount).toBe(7);
    expect(pants.items.map(i => i.sku)).toEqual(["A-1", "A-2"]);
  });

  it("sorts groups alphabetically by class name", () => {
    const groups = groupByClass([row("A", "Zippers", 1), row("B", "Aprons", 1), row("C", "Mitts", 1)]);
    expect(groups.map(g => g.className)).toEqual(["Aprons", "Mitts", "Zippers"]);
  });

  it("pins Uncategorized last even when it would sort first alphabetically", () => {
    const groups = groupByClass([row("A", null, 1), row("B", "Zippers", 1)]);
    expect(groups.map(g => g.className)).toEqual(["Zippers", "Uncategorized"]);
  });

  it("collects null, empty, and whitespace-only class names into one Uncategorized group", () => {
    const groups = groupByClass([row("A", null, 1), row("B", "", 2), row("C", "   ", 3), row("D", undefined, 4)]);
    expect(groups.length).toBe(1);
    expect(groups[0].className).toBe("Uncategorized");
    expect(groups[0].skuCount).toBe(4);
    expect(groups[0].unitCount).toBe(10);
  });

  it("trims surrounding whitespace so ' Pants ' and 'Pants' are one group", () => {
    const groups = groupByClass([row("A", " Pants ", 1), row("B", "Pants", 2)]);
    expect(groups.length).toBe(1);
    expect(groups[0].unitCount).toBe(3);
  });

  it("treats non-numeric quantities as zero", () => {
    const groups = groupByClass([row("A", "Pants", null), row("B", "Pants", "5")]);
    expect(groups[0].unitCount).toBe(5);
  });
});

describe("shouldAutoExpand", () => {
  it("expands at and below the threshold", () => {
    expect(shouldAutoExpand(0)).toBe(true);
    expect(shouldAutoExpand(1)).toBe(true);
    expect(shouldAutoExpand(AUTO_EXPAND_MAX_SKUS)).toBe(true);
  });

  it("collapses above the threshold", () => {
    expect(shouldAutoExpand(AUTO_EXPAND_MAX_SKUS + 1)).toBe(false);
    expect(shouldAutoExpand(500)).toBe(false);
  });

  it("uses 25 as the threshold", () => {
    expect(AUTO_EXPAND_MAX_SKUS).toBe(25);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/binLookupGrouping.test.js
```

Expected: FAIL — `Failed to resolve import "./binLookupGrouping"`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/binLookupGrouping.js`:

```js
// ═══════════════════════════════════════════════════════════
// BIN LOOKUP — pure grouping helpers
//
// Kept free of React so the rules that actually matter (group
// ordering, the Uncategorized bucket, the auto-expand threshold)
// can be tested in the default node environment.
// ═══════════════════════════════════════════════════════════

export const UNCATEGORIZED = "Uncategorized";

// A bin with more SKUs than this renders with every class group
// collapsed — a Sales Floor catch-all bin becomes a short menu of
// classes instead of thousands of rows. At or below it, the bin
// reads as a plain list with no tapping.
export const AUTO_EXPAND_MAX_SKUS = 25;

/**
 * Group inventory rows by item class.
 * Returns [{ className, items, skuCount, unitCount }] sorted by class
 * name, with the Uncategorized group always last.
 */
export function groupByClass(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const raw = typeof row.class_name === "string" ? row.class_name.trim() : "";
    const className = raw || UNCATEGORIZED;
    if (!map.has(className)) {
      map.set(className, { className, items: [], skuCount: 0, unitCount: 0 });
    }
    const group = map.get(className);
    group.items.push(row);
    group.skuCount += 1;
    group.unitCount += Number(row.qty_on_hand) || 0;
  }

  return [...map.values()].sort((a, b) => {
    if (a.className === UNCATEGORIZED) return 1;
    if (b.className === UNCATEGORIZED) return -1;
    return a.className.localeCompare(b.className);
  });
}

/** Should every class group start expanded for a bin of this size? */
export function shouldAutoExpand(skuCount) {
  return skuCount <= AUTO_EXPAND_MAX_SKUS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/binLookupGrouping.test.js
```

Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/binLookupGrouping.js src/modules/binLookupGrouping.test.js
git commit -m "feat: bin lookup grouping helpers"
```

---

## Task 2: BinLookup screen — location picker and sticky location

The employee picks a location once; it persists so returning employees land on the scan screen.

**Files:**
- Create: `src/modules/BinLookup.jsx`
- Test: `src/modules/BinLookup.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/BinLookup.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import BinLookup from "./BinLookup";

const SESSION_KEY = "glww_bin_lookup";
const LOC_SF = { id: "3", name: "Sales Floor" };

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    if (url === "/api/suiteql") {
      return { ok: true, json: async () => ({ items: [{ id: "1", name: "Warehouse" }, LOC_SF], hasMore: false }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe("location picker", () => {
  it("lists locations and advances to the scan screen when one is chosen", async () => {
    render(<BinLookup onBack={() => {}} />);
    const sf = await screen.findByRole("button", { name: /Sales Floor/ });
    fireEvent.click(sf);
    expect(screen.getByPlaceholderText("Scan bin...")).toBeTruthy();
  });

  it("remembers the chosen location", async () => {
    render(<BinLookup onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Sales Floor/ }));
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)).location).toEqual(LOC_SF);
  });

  it("mounts straight into the scan screen when a location is remembered, with no location query", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ location: LOC_SF }));
    render(<BinLookup onBack={() => {}} />);
    expect(screen.getByPlaceholderText("Scan bin...")).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns to the picker and forgets the location when Change Location is tapped", async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ location: LOC_SF }));
    render(<BinLookup onBack={() => {}} />);
    fireEvent.click(screen.getByText("Change Location"));
    expect(await screen.findByRole("button", { name: /Warehouse/ })).toBeTruthy();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: FAIL — `Failed to resolve import "./BinLookup"`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/BinLookup.jsx`:

```jsx
import { useState, useEffect, useCallback, useRef } from "react";
import {
  suiteql,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo, PulsingDot, ScanInput,
  loadSession, saveSession, clearSession,
} from "../shared";

// ═══════════════════════════════════════════════════════════
// BIN LOOKUP MODULE — read-only "what's in this bin?"
//
// Two phases. Location first, because bin numbers are only unique
// per location. The location sticks in localStorage so a returning
// employee lands straight on the scan screen.
// ═══════════════════════════════════════════════════════════

const ACCENT = "#14b8a6";
const SESSION_KEY = "glww_bin_lookup";

export default function BinLookup({ onBack }) {
  const [selectedLocation, setSelectedLocation] = useState(
    () => loadSession(SESSION_KEY)?.location || null
  );
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const scanRef = useRef(null);

  // Phase is derived, not stored — one source of truth.
  const phase = selectedLocation ? "scan" : "location";

  // ── LOAD LOCATIONS (only when we actually need the picker) ──
  useEffect(() => {
    if (selectedLocation || locations.length > 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await suiteql(`SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name`);
        if (!cancelled) setLocations(rows);
      } catch (e) {
        if (!cancelled) setError(`Failed to load locations: ${e.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedLocation, locations.length]);

  const selectLocation = useCallback((loc) => {
    setSelectedLocation(loc);
    saveSession(SESSION_KEY, { location: loc });
    setError(null);
  }, []);

  const changeLocation = useCallback(() => {
    setSelectedLocation(null);
    clearSession(SESSION_KEY);
    setError(null);
  }, []);

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* ════════════ HEADER ════════════ */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>Bin Lookup</span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Home</button>
      </div>

      <div style={{ padding: "16px 16px 40px" }}>

        {/* ════════════ PHASE 1 — SELECT LOCATION ════════════ */}
        {phase === "location" && (
          <div style={fadeIn}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Select Location</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Bin numbers repeat across locations</div>
            </div>

            {loading && <PulsingDot color={ACCENT} label="Loading locations..." />}
            {error && <div style={S.err}>{error}</div>}

            {!loading && locations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {locations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => selectLocation(loc)}
                    style={{
                      ...S.card, cursor: "pointer", padding: "14px 16px", marginBottom: 0,
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      border: `1px solid ${ACCENT}25`, background: `${ACCENT}06`,
                      fontFamily: "inherit", transition: "all 0.15s", touchAction: "manipulation",
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{loc.name}</span>
                    <span style={{ color: "#475569", fontSize: 16 }}>›</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════ PHASE 2 — SCAN BIN ════════════ */}
        {phase === "scan" && (
          <div style={fadeIn}>
            <div style={{
              ...S.card, textAlign: "center", padding: 20, marginBottom: 12,
              border: `2px solid ${ACCENT}4d`, background: `${ACCENT}0a`,
            }}>
              <div style={{
                fontSize: 12, color: ACCENT, textTransform: "uppercase",
                letterSpacing: 1, fontWeight: 700, marginBottom: 10,
              }}>
                Scan Bin · {selectedLocation.name}
              </div>
              <ScanInput inputRef={scanRef} onScan={() => {}} placeholder="Scan bin..." />
            </div>

            {error && <div style={S.err}>{error}</div>}

            <button onClick={changeLocation} style={S.btnSec}>Change Location</button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinLookup.jsx src/modules/BinLookup.test.jsx
git commit -m "feat: bin lookup location picker with sticky location"
```

---

## Task 3: Bin scan — resolve, load contents, three outcomes

This is the heart of the feature. Resolving the bin separately from loading its contents is what lets the screen say "that bin doesn't exist here" instead of the ambiguous message Bin Transfer shows today.

**Files:**
- Modify: `src/modules/BinLookup.jsx`
- Test: `src/modules/BinLookup.test.jsx`

- [ ] **Step 1: Write the failing tests**

In `src/modules/BinLookup.test.jsx`, replace the whole `beforeEach` block with the version below, which records every call so tests can assert which queries ran, then append the new describe block.

```jsx
let fetchCalls, validateResponse, contentRows;

beforeEach(() => {
  fetchCalls = [];
  validateResponse = { valid: true, binId: "77", binNumber: "F-01-0001" };
  contentRows = [];
  global.fetch = vi.fn(async (url, opts) => {
    fetchCalls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    if (String(url).startsWith("/api/bins/validate")) {
      return { ok: true, json: async () => validateResponse };
    }
    if (url === "/api/suiteql") {
      const q = JSON.parse(opts.body).query;
      if (q.includes("FROM location")) {
        return { ok: true, json: async () => ({ items: [{ id: "1", name: "Warehouse" }, LOC_SF], hasMore: false }) };
      }
      return { ok: true, json: async () => ({ items: contentRows, hasMore: false }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

// Mount already parked on the scan screen.
const renderScanScreen = () => {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ location: LOC_SF }));
  render(<BinLookup onBack={() => {}} />);
  return screen.getByPlaceholderText("Scan bin...");
};

// Simulate a scanner gun: type the value, then Enter.
const scan = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

const contentQueries = () =>
  fetchCalls.filter(c => c.url === "/api/suiteql" && !c.body.query.includes("FROM location"));

const itemRow = (sku, class_name, qty) => ({
  item_id: sku, sku, item_name: `${sku} name`, class_name,
  qty_on_hand: qty, qty_available: qty,
});

describe("bin scan outcomes", () => {
  it("reports a bin that does not exist at this location and never queries contents", async () => {
    validateResponse = { valid: false };
    const input = renderScanScreen();
    scan(input, "F-09-9999");
    await screen.findByText(/doesn't exist at Sales Floor/);
    expect(contentQueries().length).toBe(0);
  });

  it("validates against the remembered location", async () => {
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText(/is empty/);
    const call = fetchCalls.find(c => c.url.startsWith("/api/bins/validate"));
    expect(call.url).toContain("locationId=3");
    expect(call.url).toContain("binNumber=F-01-0001");
  });

  it("shows an empty state, not an error, for a bin that exists but holds nothing", async () => {
    contentRows = [];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText(/is empty/);
    expect(screen.queryByText(/doesn't exist/)).toBeNull();
    expect(screen.queryByText(/Bin lookup failed/)).toBeNull();
  });

  it("queries contents by resolved bin id and location, not by bin number string", async () => {
    contentRows = [itemRow("A-1", "Pants", 3)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("A-1");
    const q = contentQueries().pop().body.query;
    expect(q).toMatch(/ib\.binnumber = 77\b/);
    expect(q).toMatch(/ib\.location = 3\b/);
    expect(q).not.toContain("F-01-0001");
  });

  it("pages through all contents rather than taking a single page", async () => {
    contentRows = [itemRow("A-1", "Pants", 3)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("A-1");
    // suiteqlAll always sends an explicit offset; suiteql never does.
    expect(contentQueries().pop().body.offset).toBe(0);
  });

  it("surfaces a failed lookup as an error and leaves no stale contents", async () => {
    contentRows = [itemRow("A-1", "Pants", 3)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("A-1");

    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: "NetSuite timeout" }) }));
    scan(input, "F-02-0002");
    await screen.findByText(/Bin lookup failed: NetSuite timeout/);
    expect(screen.queryByText("A-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: FAIL — the scan input's `onScan` is still a no-op, so nothing renders. Errors like `Unable to find an element with the text: /is empty/`.

- [ ] **Step 3: Write the implementation**

In `src/modules/BinLookup.jsx`, extend the import from `../shared` to add `suiteqlAll`, `beepOk`, `beepWarn`, and `beepBin`:

```jsx
import {
  suiteql, suiteqlAll, beepOk, beepWarn, beepBin,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo, PulsingDot, ScanInput,
  loadSession, saveSession, clearSession,
} from "../shared";
```

Add this state below `const [error, setError] = useState(null);`:

```jsx
  const [bin, setBin] = useState(null);        // { binId, binNumber } — resolved bin
  const [rows, setRows] = useState([]);        // contents of `bin`
  const [progress, setProgress] = useState(0); // rows loaded so far
  const [flash, setFlash] = useState(null);
```

Add the flash helper and the scan handler directly above the `return (`:

```jsx
  const doFlash = (type) => { setFlash(type); setTimeout(() => setFlash(null), 400); };

  // ── SCAN A BIN ──
  // Two calls: resolve the bin (so "missing" and "empty" stay
  // distinguishable), then page in its contents by internal ID.
  const handleBinScan = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed || !selectedLocation) return;

    setError(null); setBin(null); setRows([]); setProgress(0); setLoading(true);

    try {
      const resp = await fetch(
        `/api/bins/validate?locationId=${encodeURIComponent(selectedLocation.id)}` +
        `&binNumber=${encodeURIComponent(trimmed)}`
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);

      if (!data.valid) {
        beepWarn(); doFlash("warn");
        setError(`Bin "${trimmed}" doesn't exist at ${selectedLocation.name}`);
        return;
      }

      // suiteqlAll, not suiteql: catch-all Sales Floor bins run to
      // thousands of SKUs and the 1000-row default would silently
      // drop everything past the cutoff.
      const contents = await suiteqlAll(`
        SELECT
          ib.item AS item_id,
          item.itemid AS sku,
          item.displayname AS item_name,
          BUILTIN.DF(item.class) AS class_name,
          ib.quantityonhand AS qty_on_hand,
          ib.quantityavailable AS qty_available
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        WHERE ib.binnumber = ${Number(data.binId)}
          AND ib.location = ${Number(selectedLocation.id)}
          AND ib.quantityonhand > 0
        ORDER BY BUILTIN.DF(item.class), item.itemid
      `, (loaded) => setProgress(loaded));

      setBin({ binId: data.binId, binNumber: data.binNumber });
      setRows(contents);

      if (contents.length === 0) { beepOk(); doFlash("ok"); }
      else { beepBin(); doFlash("bin"); }
    } catch (e) {
      beepWarn(); doFlash("warn");
      setBin(null); setRows([]);
      setError(`Bin lookup failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedLocation]);
```

Wire the handler and flash into the scan input, replacing the placeholder `ScanInput` line:

```jsx
              <ScanInput inputRef={scanRef} onScan={handleBinScan} placeholder="Scan bin..." flash={flash} />
              {loading && (
                <PulsingDot
                  color={ACCENT}
                  label={progress > 0 ? `Loaded ${progress.toLocaleString()} items…` : "Looking up bin…"}
                />
              )}
```

Add the empty-bin card between the `{error && ...}` line and the Change Location button:

```jsx
            {bin && rows.length === 0 && (
              <div style={{
                ...S.card, textAlign: "center", padding: 20,
                background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: "#fbbf24" }}>{bin.binNumber}</div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 6 }}>
                  This bin is empty — 0 SKUs, 0 units.
                </div>
              </div>
            )}
```

Add a bare contents list between the empty-bin card and the Change Location button. Task 4 replaces it with the grouped view; it exists now only so the outcome tests can assert on rendered SKUs:

```jsx
            {bin && rows.length > 0 && (
              <div style={S.card}>
                {rows.map(r => (
                  <div key={r.item_id} style={{ fontSize: 13, ...mono, color: "#e2e8f0", padding: "4px 0" }}>
                    {r.sku}
                  </div>
                ))}
              </div>
            )}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: PASS — 10 tests (4 from Task 2, 6 new).

Note: code review of Task 3 added two more regression tests (stale results on location change; overlapping scans), so the file carries 12 tests from Task 4 onward.

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinLookup.jsx src/modules/BinLookup.test.jsx
git commit -m "feat: bin lookup resolves bin then pages in contents"
```

---

## Task 4: Grouped results, stat strip, and item detail drawer

Replaces the bare list from Task 3 with the real screen.

**Files:**
- Modify: `src/modules/BinLookup.jsx`
- Test: `src/modules/BinLookup.test.jsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/BinLookup.test.jsx`:

```jsx
const manyRows = (n) =>
  Array.from({ length: n }, (_, i) => itemRow(`SKU-${i}`, i % 2 ? "Pants" : "Gloves", 2));

describe("grouped results", () => {
  it("shows a stat strip with the bin, location, SKU count and unit count", async () => {
    contentRows = [itemRow("A-1", "Pants", 3), itemRow("A-2", "Gloves", 4)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("F-01-0001");
    expect(screen.getByText(/2 SKUs/)).toBeTruthy();
    expect(screen.getByText(/7 units/)).toBeTruthy();
    expect(screen.getByText("Sales Floor")).toBeTruthy();
  });

  it("expands every group for a small bin so items are visible without tapping", async () => {
    contentRows = manyRows(4);
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    expect(await screen.findByText("SKU-0")).toBeTruthy();
    expect(screen.getByText("SKU-3")).toBeTruthy();
  });

  it("collapses every group for a bin over the threshold", async () => {
    contentRows = manyRows(26);
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("Gloves");
    expect(screen.queryByText("SKU-0")).toBeNull();
  });

  it("opens a collapsed group when its header is tapped", async () => {
    contentRows = manyRows(26);
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    fireEvent.click(await screen.findByText("Gloves"));
    expect(screen.getByText("SKU-0")).toBeTruthy();
  });

  it("orders groups alphabetically with Uncategorized last", async () => {
    contentRows = [itemRow("A-1", "Pants", 1), itemRow("A-2", null, 1), itemRow("A-3", "Gloves", 1)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("Gloves");
    const headers = screen.getAllByRole("button")
      .map(b => b.textContent)
      .filter(t => /Gloves|Pants|Uncategorized/.test(t));
    expect(headers[0]).toContain("Gloves");
    expect(headers[1]).toContain("Pants");
    expect(headers[2]).toContain("Uncategorized");
  });

  it("shows available quantity only when it differs from on hand", async () => {
    contentRows = [
      { item_id: 1, sku: "SAME", item_name: "Same", class_name: "Pants", qty_on_hand: 5, qty_available: 5 },
      { item_id: 2, sku: "DIFF", item_name: "Diff", class_name: "Pants", qty_on_hand: 5, qty_available: 2 },
    ];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("SAME");
    expect(screen.getByText("(2 avail)")).toBeTruthy();
    expect(screen.queryByText("(5 avail)")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: FAIL — the bare list has no stat strip or group headers. Errors like `Unable to find an element with the text: /2 SKUs/`.

- [ ] **Step 3: Write the implementation**

Add `useMemo` to the React import:

```jsx
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
```

Add the drawer and grouping imports below the `../shared` import:

```jsx
import ItemDetailDrawer from "../components/ItemDetail";
import { groupByClass, shouldAutoExpand } from "./binLookupGrouping";
```

Add this state next to the others:

```jsx
  const [expanded, setExpanded] = useState({});   // className -> open?
  const [drawerItemId, setDrawerItemId] = useState(null);
```

Add these derived values above `doFlash`:

```jsx
  const groups = useMemo(() => groupByClass(rows), [rows]);
  const totalUnits = useMemo(
    () => rows.reduce((sum, r) => sum + (Number(r.qty_on_hand) || 0), 0),
    [rows]
  );

  // Reseed the open/closed state whenever a new bin's contents land.
  useEffect(() => {
    const open = shouldAutoExpand(rows.length);
    setExpanded(Object.fromEntries(groups.map(g => [g.className, open])));
  }, [groups, rows.length]);

  const toggleGroup = useCallback((className) => {
    setExpanded(prev => ({ ...prev, [className]: !prev[className] }));
  }, []);
```

Replace the entire bare-list block from Task 3 with the grouped view:

```jsx
            {bin && rows.length > 0 && (
              <div style={fadeIn}>
                {/* Stat strip */}
                <div style={{
                  ...S.card, padding: "12px 16px", marginBottom: 10,
                  background: `${ACCENT}0f`, border: `1px solid ${ACCENT}40`,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, ...mono, color: "#5eead4" }}>{bin.binNumber}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{selectedLocation.name}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, ...mono, color: "#e2e8f0" }}>
                      {rows.length.toLocaleString()} SKUs
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, ...mono, color: "#22c55e" }}>
                      {totalUnits.toLocaleString()} units
                    </div>
                  </div>
                </div>

                {/* Class groups */}
                {groups.map(group => {
                  const isOpen = !!expanded[group.className];
                  return (
                    <div key={group.className} style={{
                      borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)",
                      background: "rgba(255,255,255,0.03)", marginBottom: 8, overflow: "hidden",
                    }}>
                      <button
                        onClick={() => toggleGroup(group.className)}
                        style={{
                          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "12px 14px", background: "transparent", border: "none",
                          cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                          touchAction: "manipulation", minHeight: 48,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span style={{ color: "#475569", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
                          <span style={{
                            fontSize: 14, fontWeight: 700, color: "#e2e8f0",
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          }}>{group.className}</span>
                        </div>
                        <span style={{ fontSize: 11, color: "#94a3b8", ...mono, flexShrink: 0, marginLeft: 8 }}>
                          {group.skuCount} · {group.unitCount.toLocaleString()}u
                        </span>
                      </button>

                      {isOpen && group.items.map((r, i) => (
                        <div
                          key={r.item_id}
                          onClick={() => setDrawerItemId(r.item_id)}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "10px 14px", cursor: "pointer", touchAction: "manipulation",
                            borderTop: "1px solid rgba(255,255,255,0.04)",
                            background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent",
                            minHeight: 48,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{r.sku}</div>
                            <div style={{
                              fontSize: 11, color: "#64748b",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>{r.item_name}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginLeft: 12, flexShrink: 0 }}>
                            <span style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#cbd5e1" }}>{r.qty_on_hand}</span>
                            {Number(r.qty_available) !== Number(r.qty_on_hand) && (
                              <span style={{ fontSize: 11, color: "#64748b", ...mono }}>({r.qty_available} avail)</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
```

Finally, mount the drawer as the last child inside the outermost `<div style={S.root}>`, immediately before its closing `</div>`:

```jsx
      <ItemDetailDrawer
        itemId={drawerItemId}
        onClose={() => setDrawerItemId(null)}
        refocusRef={scanRef}
      />
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: PASS — 18 tests (12 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinLookup.jsx src/modules/BinLookup.test.jsx
git commit -m "feat: bin lookup class-grouped results with item drawer"
```

---

## Task 5: Activity logging

Every other module writes an audit entry. Bin Lookup logs every resolved bin, empty or not — knowing an employee checked a bin and found it empty is as useful as knowing what they found.

**Files:**
- Modify: `src/modules/BinLookup.jsx`
- Modify: `src/modules/ActivityLog.jsx`
- Test: `src/modules/BinLookup.test.jsx`

- [ ] **Step 1: Write the failing tests**

Add this import and mock at the top of `src/modules/BinLookup.test.jsx`, after the `BinLookup` import:

```jsx
import { logActivity } from "../activityLog";

vi.mock("../activityLog", () => ({ logActivity: vi.fn() }));
```

Because `logActivity` is now a shared mock, update the existing `afterEach` in this file to reset call counts between tests:

```jsx
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });
```

Append this describe:

```jsx
describe("activity logging", () => {
  it("logs a lookup that found items", async () => {
    contentRows = [itemRow("A-1", "Pants", 3), itemRow("A-2", "Gloves", 4)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("A-1");
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({
      module: "bin-lookup",
      action: "bin-lookup",
      status: "success",
      sourceDocument: "F-01-0001",
      details: "F-01-0001 @ Sales Floor — 2 SKUs, 7 units",
    }));
  });

  it("logs a lookup of an empty bin", async () => {
    contentRows = [];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText(/is empty/);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({
      details: "F-01-0001 @ Sales Floor — empty",
    }));
  });

  it("does not log a bin that does not exist", async () => {
    validateResponse = { valid: false };
    const input = renderScanScreen();
    scan(input, "F-09-9999");
    await screen.findByText(/doesn't exist at Sales Floor/);
    expect(logActivity).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: FAIL — `expected "logActivity" to be called with arguments`, received 0 calls.

- [ ] **Step 3: Write the implementation**

In `src/modules/BinLookup.jsx`, add the import below the grouping import:

```jsx
import { logActivity } from "../activityLog";
```

In `handleBinScan`, replace the beep block at the end of the `try` with a version that also logs:

```jsx
      const units = contents.reduce((sum, r) => sum + (Number(r.qty_on_hand) || 0), 0);
      if (contents.length === 0) { beepOk(); doFlash("ok"); }
      else { beepBin(); doFlash("bin"); }

      try {
        logActivity({
          module: "bin-lookup",
          action: "bin-lookup",
          status: "success",
          details: contents.length === 0
            ? `${data.binNumber} @ ${selectedLocation.name} — empty`
            : `${data.binNumber} @ ${selectedLocation.name} — ${contents.length} SKUs, ${units} units`,
          sourceDocument: data.binNumber,
        });
      } catch (_) { }
```

In `src/modules/ActivityLog.jsx`, add the module to `MODULE_OPTIONS`, after the `item-lookup` entry:

```jsx
  { value: "bin-lookup", label: "Bin Lookup" },
```

Add its action list to `ACTION_OPTIONS`, after the `"item-lookup"` entry:

```jsx
  "bin-lookup": [
    { value: "", label: "All Actions" },
    { value: "bin-lookup", label: "Bin Lookup" },
  ],
```

Add the label to `ACTION_LABELS`, after `"item-lookup": "Item Lookup",`:

```jsx
  "bin-lookup": "Bin Lookup",
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/modules/BinLookup.test.jsx
```

Expected: PASS — 21 tests (18 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/modules/BinLookup.jsx src/modules/BinLookup.test.jsx src/modules/ActivityLog.jsx
git commit -m "feat: log bin lookups to the activity log"
```

---

## Task 6: Wire into navigation

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/Home.jsx`

- [ ] **Step 1: Add the route**

In `src/App.jsx`, add the import after the `ItemLookup` import:

```jsx
import BinLookup from "./modules/BinLookup";
```

Add the route immediately after the `item-lookup` line:

```jsx
  if (module === "bin-lookup") return <BinLookup onBack={onBack} />;
```

- [ ] **Step 2: Add the home screen utility bar**

In `src/Home.jsx`, the Item Lookup button sits inside a `{!selectedCategory && ( ... )}` block that currently holds a single element. Wrap both bars in a fragment. Replace:

```jsx
        {!selectedCategory && (
          <button
            onClick={() => setModule("item-lookup")}
```

with:

```jsx
        {!selectedCategory && (
          <>
          <button
            onClick={() => setModule("item-lookup")}
```

Then find the end of that same button — the line `          </button>` followed by `        )}` — and replace those two lines with the Bin Lookup bar plus the fragment close:

```jsx
          </button>

          <button
            onClick={() => setModule("bin-lookup")}
            style={{
              display: "flex", alignItems: "center", gap: 12, width: "100%",
              padding: "14px 16px", marginBottom: 16,
              background: "rgba(20,184,166,0.04)",
              border: "1px solid rgba(20,184,166,0.25)",
              borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
              textAlign: "left", transition: "all 0.15s",
              touchAction: "manipulation", minHeight: 56,
            }}
          >
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: "rgba(20,184,166,0.12)", border: "1px solid rgba(20,184,166,0.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, color: "#14b8a6", flexShrink: 0,
            }}>▤</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>Bin Lookup</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>Scan a bin to see what's in it</div>
            </div>
            <div style={{ marginLeft: "auto", color: "#475569", fontSize: 18 }}>›</div>
          </button>
          </>
        )}
```

- [ ] **Step 3: Verify the app builds**

```bash
npm run build
```

Expected: `built in ...` with no errors. A JSX syntax error in the Home.jsx fragment edit shows up here.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx src/Home.jsx
git commit -m "feat: surface Bin Lookup on the home screen"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the whole suite**

```bash
npm test
```

Expected: all test files pass, including the pre-existing `BinTransfer.crossLocation`, `ItemReceipts.notOnPO`, `CompletePickModal`, `usePickSession.fulfillBody`, and the `api/` tests. Bin Lookup contributes 21 component tests plus 10 grouping tests.

- [ ] **Step 2: Confirm no `suiteql` regression in the new module**

```bash
grep -n "suiteql" src/modules/BinLookup.jsx
```

Expected: the location query uses `suiteql`; the bin contents query uses `suiteqlAll`. If contents use `suiteql`, large bins silently truncate — fix before shipping.

- [ ] **Step 3: Manual smoke test**

```bash
npm run dev
```

Walk through: home → Bin Lookup → pick a location → scan a real bin → confirm the stat strip counts match NetSuite, groups expand and collapse, and tapping a row opens the item drawer. Reload the page and confirm it lands straight on the scan screen with the location remembered. Scan a bin number that exists only at a different location and confirm the "doesn't exist at" message.

Note: `npm run dev` serves the frontend only. `/api/bins/validate` and `/api/suiteql` need `vercel dev`, or the temp Vite proxy to the deployed Vercel API used for live NetSuite tests in this project.

---

## Deferred

Not in this plan, by design — see the spec's Out of Scope section: recent-bin history, sort/filter controls beyond class grouping, and any verify/count mode.
