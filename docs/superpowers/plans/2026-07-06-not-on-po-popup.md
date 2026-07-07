# Not-on-PO Blocking Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a scanned barcode doesn't match any UPC/SKU on the selected PO in Item Receipts, show a blocking modal ("Last Item Scanned is not on PO") that ignores all scans until dismissed with OK.

**Architecture:** All changes live in `src/modules/ItemReceipts.jsx` — one new `notOnPO` state variable, early-return guards in the two scan handlers, and a fixed-inset modal rendered in the receive phase (same overlay pattern as `InventoryCount.jsx`). Component tests run in jsdom via Testing Library, seeded through the module's own localStorage session-resume path so no network mocking is needed.

**Tech Stack:** React 18, Vite, Vitest 4 (currently node environment; tests opt into jsdom per-file via `// @vitest-environment jsdom`), @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-06-not-on-po-popup-design.md`

---

## File Structure

- Modify: `package.json` — add dev deps `jsdom`, `@testing-library/react`, `@testing-library/dom`
- Create: `src/modules/ItemReceipts.notOnPO.test.jsx` — component tests for the popup
- Modify: `src/modules/ItemReceipts.jsx` — state, scan-handler guards, modal JSX

---

### Task 1: Component-test infrastructure

**Files:**
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Install dev dependencies**

Run (from repo root):
```bash
npm install -D jsdom @testing-library/react @testing-library/dom
```
Expected: exits 0, `package.json` devDependencies now include all three.

No vitest.config.js change — the global environment stays `node` (the existing `api/_split-fulfill.test.js` relies on it). The new test file selects jsdom with a `// @vitest-environment jsdom` comment on its first line.

- [ ] **Step 2: Verify the existing suite still passes**

Run: `npm test`
Expected: `api/_split-fulfill.test.js` passes, exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "test: add jsdom + Testing Library for component tests"
```

---

### Task 2: Blocking not-on-PO modal (TDD)

**Files:**
- Create: `src/modules/ItemReceipts.notOnPO.test.jsx`
- Modify: `src/modules/ItemReceipts.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/ItemReceipts.notOnPO.test.jsx` with exactly:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ItemReceipts from "./ItemReceipts";

const SESSION_KEY = "glww_item_receipts";

// A saved session already in the receive phase with a bin selected, so the
// component mounts straight to the item-scan screen (after clicking Resume)
// without any suiteql network calls.
const session = {
  phase: "receive",
  openPOs: [],
  selectedPO: { internalid: 101, po_number: "PO123" },
  poLines: [{
    line_id: 1, line_number: 1, item_id: 555, item_name: "Test Glove",
    ordered_qty: 5, received_qty: 0, remaining_qty: 5,
    sku: "GLV-1", upc: "012345678905",
  }],
  currentBin: "BIN-A",
  binHistory: ["BIN-A"],
  receivedItems: {},
  binItems: {},
  receiptNumber: null,
  receiptSubmitted: false,
};

const VALID_UPC = "012345678905";
const UNKNOWN_UPC = "999999999999";
const MODAL_TITLE = "Last Item Scanned is not on PO";

// Simulate a scanner gun: type the value, then Enter.
const scan = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

// ScanInput queues scans that arrive <100ms apart; wait out that window so
// each scan in a test is processed synchronously through onScan.
const pause = () => new Promise((r) => setTimeout(r, 120));

// The "N of M items" progress readout. Function matcher because the span has
// multiple text children, and ancestors would also regex-match textContent.
const progressText = () =>
  screen.getByText((_, el) => el.tagName === "SPAN" && /of 5 items$/.test(el.textContent)).textContent;

function renderReceiveScreen() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  render(<ItemReceipts onBack={() => {}} />);
  fireEvent.click(screen.getByText("Resume Session"));
  return screen.getByPlaceholderText("Scan item UPC...");
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("not-on-PO blocking popup", () => {
  it("opens the modal on an unknown scan and counts nothing", async () => {
    const input = renderReceiveScreen();
    scan(input, UNKNOWN_UPC);
    expect(await screen.findByText(MODAL_TITLE)).toBeTruthy();
    expect(screen.getByText(UNKNOWN_UPC)).toBeTruthy(); // scanned barcode shown
    expect(progressText()).toBe("0 of 5 items");
  });

  it("ignores further scans while the modal is open", async () => {
    const input = renderReceiveScreen();
    scan(input, UNKNOWN_UPC);
    await screen.findByText(MODAL_TITLE);
    await pause();
    scan(input, VALID_UPC); // on the PO, but must be ignored while blocked
    await pause();
    expect(progressText()).toBe("0 of 5 items");
    expect(screen.getByText(MODAL_TITLE)).toBeTruthy(); // still open
  });

  it("OK dismisses the modal and the next valid scan counts", async () => {
    const input = renderReceiveScreen();
    scan(input, UNKNOWN_UPC);
    await screen.findByText(MODAL_TITLE);
    fireEvent.click(screen.getByText("OK"));
    expect(screen.queryByText(MODAL_TITLE)).toBeNull();
    await pause();
    scan(input, VALID_UPC);
    expect(progressText()).toBe("1 of 5 items");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/ItemReceipts.notOnPO.test.jsx`
Expected: all 3 tests FAIL — `findByText("Last Item Scanned is not on PO")` times out (the modal doesn't exist yet). If they fail on rendering/mounting instead (import errors, missing "Resume Session"), fix the harness before proceeding — the tests must fail for the right reason.

- [ ] **Step 3: Implement the modal in ItemReceipts.jsx**

All edits in `src/modules/ItemReceipts.jsx`.

**3a — state.** After the `const [flash, setFlash] = useState(null);` line (~line 74), add:

```jsx
const [notOnPO, setNotOnPO] = useState(null); // raw scanned value not on the PO; blocks scanning while set
```

**3b — guard the bin scanner.** Replace `handleBinScan`:

```jsx
const handleBinScan = useCallback((val) => {
  if (notOnPO) return;
  const bin = val.trim(); if (!bin) return;
  setCurrentBin(bin);
  if (!binHistory.includes(bin)) setBinHistory(p => [...p, bin]);
}, [binHistory, notOnPO]);
```

**3c — guard the item scanner and open the modal.** Replace the first two lines of `handleItemScan` and its dependency array:

```jsx
const handleItemScan = useCallback((val) => {
  if (notOnPO) return;
  const item = findItem(val);
  if (!item) { beepWarn(); setNotOnPO(val.trim()); return; }
  const binKey = `${currentBin}::${item.item_id}`;
  setBinItems(p => ({ ...p, [binKey]: (p[binKey] || 0) + 1 }));
  setReceivedItems(p => ({ ...p, [item.item_id]: (p[item.item_id] || 0) + 1 }));
  const remaining = Number(item.remaining_qty);
  const newCount = (receivedItems[item.item_id] || 0) + 1;
  if (newCount > remaining) {
    beepWarn(); setFlash("extra");
  } else {
    beepOk(); setFlash("ok");
  }
  setTimeout(() => setFlash(null), 400);
}, [currentBin, receivedItems, upcLookup, skuLookup, poLines, notOnPO]);
```

(The old `setFlash("warn")` branch for unknown scans is replaced by the modal.)

**3d — dismiss handler.** After the `const switchBin = ...` line, add:

```jsx
const dismissNotOnPO = () => {
  setNotOnPO(null);
  setTimeout(() => scanRef.current?.focus(), 50);
};
```

**3e — modal JSX.** In the receive-phase render, immediately before `{DrawerComponent}` (after the closing `</div>` of the padded content div), add:

```jsx
{notOnPO && (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <div style={{ ...S.card, width: "100%", maxWidth: 340, textAlign: "center", padding: 24,
      marginBottom: 0, border: "2px solid rgba(245,158,11,0.5)" }}>
      <div style={{ fontSize: 34, marginBottom: 10 }}>⚠️</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: ACCENT, marginBottom: 8 }}>
        Last Item Scanned is not on PO
      </div>
      <div style={{ fontSize: 14, color: "#94a3b8", ...mono, marginBottom: 18, wordBreak: "break-all" }}>
        {notOnPO}
      </div>
      <button style={{ ...S.btn, background: ACCENT }} onClick={dismissNotOnPO}>OK</button>
    </div>
  </div>
)}
```

Notes:
- No overlay-click dismissal (deliberate, per spec — acknowledgment must be the OK tap).
- `zIndex: 1000` sits above the ItemDetail drawer (900/910).
- `notOnPO` is intentionally NOT added to the auto-save session effect — a momentary alert shouldn't survive a reload.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run src/modules/ItemReceipts.notOnPO.test.jsx`
Expected: 3 passed.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass (new file + `api/_split-fulfill.test.js`), exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ItemReceipts.jsx src/modules/ItemReceipts.notOnPO.test.jsx
git commit -m "feat: blocking not-on-PO popup in Item Receipts"
```

---

### Task 3: Build check

- [ ] **Step 1: Verify production build still compiles**

Run: `npm run build`
Expected: Vite build completes with exit 0, no errors referencing ItemReceipts.

- [ ] **Step 2 (manual, optional): Live smoke test**

In `npm run dev`, open Item Receipts → select a real PO → scan a barcode not on it. Modal appears with the barcode; further trigger pulls do nothing; OK dismisses and refocuses; a valid UPC then counts normally. (Memory note: live test PO context exists in NetSuite; any open PO works for this.)
