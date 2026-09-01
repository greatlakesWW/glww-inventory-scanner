# Receiving Scan Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a receiver take a mis-scanned unit back off a PO line, attributed to a specific bin, without discarding the scanning session.

**Architecture:** All changes live in one file, `src/modules/ItemReceipts.jsx`. One new piece of transient state (`adjustingItemId`) tracks which line's adjust panel is open. Tapping a line's quantity readout toggles that panel; the panel lists the bins that line was scanned into and removes one unit from the bin you tap. It edits the existing `receivedItems` and `binItems` session maps in place — no new session fields, no new API route, nothing sent to NetSuite.

**Tech Stack:** React 18 (hooks, no state library), Vite, Vitest + React Testing Library (jsdom). Inline style objects from `src/shared.jsx` — this codebase has no CSS files and no `data-testid` convention, so tests query by visible text.

**Spec:** [docs/superpowers/specs/2026-09-01-receiving-scan-correction-design.md](../specs/2026-09-01-receiving-scan-correction-design.md)

---

## Background You Need

**How receiving stores scans.** Two maps in component state, both persisted to `localStorage` by an existing auto-save `useEffect` at `src/modules/ItemReceipts.jsx:114`:

- `receivedItems` — `{ "<itemId>": count }`, total units scanned this session per PO line.
- `binItems` — `{ "<binName>::<itemId>": count }`, the same units broken out by bin.

Every scan increments both (`handleItemScan`, `src/modules/ItemReceipts.jsx:200`). Nothing ever decrements them. That is the bug.

**Bins are always present.** `BinScanner` (`src/shared.jsx:275`) refuses to render the item scan input until `currentBin` is set, so `handleItemScan` can never write a `null::<itemId>` key. Any line with scans has at least one real bin.

**Scan focus is fragile.** `useScanRefocus` (`src/shared.jsx:158`) refocuses the scan input from a `document`-level click listener. Calling `e.stopPropagation()` in a React handler stops the native event before it reaches `document`, so that listener will **not** fire for clicks inside the panel. Every panel handler that needs the scanner back must call `scanRef.current?.focus()` itself. This is the same thing `dismissNotOnPO` (`src/modules/ItemReceipts.jsx:219`) already does.

**Why stopPropagation at all.** The row `<div>` has `onClick={() => openDrawer(line.item_id)}`. Without `stopPropagation`, tapping the readout or a panel button would also open the item detail drawer.

## File Structure

- **Modify:** `src/modules/ItemReceipts.jsx` — new `adjustingItemId` state, a `toggleAdjust` and a `removeOneUnit` handler, and two render changes inside the existing PO-line map (tappable readout, adjust panel).
- **Create:** `src/modules/ItemReceipts.adjustQty.test.jsx` — all tests for this feature.

No other file changes. No new session fields, so a session already saved on a handheld resumes intact after deploy.

---

### Task 1: Adjust panel opens and closes

> **Executed and revised.** Shipped as `e464545` + `3841369` + `6ff00bf`. Two review rounds changed the code below, so read the committed source as authoritative, not these snippets. What changed: a `refocusScan()` helper and a `closeAdjust()` helper were extracted, and **every** `stopPropagation` path now restores scan focus — including the bin button, which does it via `removeOneUnit` itself rather than its `onClick` (the button's own `stopPropagation` stops the click reaching the panel wrapper). `dismissNotOnPO` also clears `adjustingItemId`. A row-local `const isAdjusting = adjustingItemId === line.item_id && canAdjust` gates the panel. The fixture gained a fourth line (SOCK-1, received on a prior receipt, no session scans) and the test file has 9 tests. The `readout`/`queryReadout` helpers use a structural containment check for collisions, not a hit count.

**Files:**
- Create: `src/modules/ItemReceipts.adjustQty.test.jsx`
- Modify: `src/modules/ItemReceipts.jsx` (state near line 78, handler near line 219, render near lines 420–427)

- [ ] **Step 1: Write the failing test**

Create `src/modules/ItemReceipts.adjustQty.test.jsx` with exactly this content. The fixture is reused by every later task, so get it right now.

```jsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ItemReceipts from "./ItemReceipts";

const SESSION_KEY = "glww_item_receipts";

// A saved session already in the receive phase, so the component mounts
// straight to the item-scan screen (after clicking Resume) with no suiteql
// network calls. Three lines cover the three cases this feature cares about:
//   GLV-1  (555) 3 units across TWO bins, ordered 5  -> adjustable, not over
//   BOOT-1 (777) 3 units in ONE bin,      ordered 2  -> adjustable, OVER
//   HAT-1  (999) never scanned,           ordered 4  -> not adjustable
const session = {
  phase: "receive",
  openPOs: [],
  selectedPO: { internalid: 101, po_number: "PO123" },
  poLines: [
    { line_id: 1, line_number: 1, item_id: 555, item_name: "Test Glove",
      ordered_qty: 5, received_qty: 0, remaining_qty: 5, sku: "GLV-1", upc: "012345678905" },
    { line_id: 2, line_number: 2, item_id: 777, item_name: "Test Boot",
      ordered_qty: 2, received_qty: 0, remaining_qty: 2, sku: "BOOT-1", upc: "012345678912" },
    { line_id: 3, line_number: 3, item_id: 999, item_name: "Test Hat",
      ordered_qty: 4, received_qty: 0, remaining_qty: 4, sku: "HAT-1", upc: "012345678929" },
  ],
  currentBin: "BIN-A",
  binHistory: ["BIN-A", "BIN-B"],
  receivedItems: { 555: 3, 777: 3 },
  binItems: { "BIN-A::555": 2, "BIN-B::555": 1, "BIN-A::777": 3 },
  receiptNumber: null,
  receiptSubmitted: false,
};

function renderReceiveScreen() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  render(<ItemReceipts onBack={() => {}} />);
  fireEvent.click(screen.getByText("Resume Session"));
}

// The qty readout renders "{rcvd}/{ordered} {✓} {⌄}" across several text nodes,
// and its wrapper div can have the identical textContent, so match on
// whitespace-stripped textContent and take the innermost (last) hit.
const norm = (s) => (s || "").replace(/\s+/g, "");
const readout = (label) => {
  const hits = screen.getAllByText((_, el) => el && norm(el.textContent) === norm(label));
  return hits[hits.length - 1];
};
const queryReadout = (label) => {
  const hits = screen.queryAllByText((_, el) => el && norm(el.textContent) === norm(label));
  return hits.length ? hits[hits.length - 1] : null;
};

// Simulate a scanner gun: type the value, then Enter.
const scan = (input, value) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

afterEach(() => { cleanup(); localStorage.clear(); });

describe("adjust panel open/close", () => {
  it("tapping the qty readout of a scanned line opens the bin list", () => {
    renderReceiveScreen();
    expect(screen.queryByText("− BIN-A (2)")).toBeNull();
    fireEvent.click(readout("3/5 ⌄"));
    expect(screen.getByText("− BIN-A (2)")).toBeTruthy();
    expect(screen.getByText("− BIN-B (1)")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("tapping the same readout again closes the panel", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    expect(screen.getByText("− BIN-A (2)")).toBeTruthy();
    fireEvent.click(readout("3/5 ⌄"));
    expect(screen.queryByText("− BIN-A (2)")).toBeNull();
  });

  it("Done closes the panel", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("Done"));
    expect(screen.queryByText("− BIN-A (2)")).toBeNull();
  });

  it("opening another line's panel closes the first", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    expect(screen.getByText("− BIN-A (2)")).toBeTruthy();
    fireEvent.click(readout("3/2 ⌄"));
    expect(screen.queryByText("− BIN-A (2)")).toBeNull();
    expect(screen.getByText("− BIN-A (3)")).toBeTruthy();
  });

  it("a line with no scans this session has no caret and opens nothing", () => {
    renderReceiveScreen();
    expect(queryReadout("0/4 ⌄")).toBeNull();
    fireEvent.click(readout("0/4"));
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("tapping the readout does not open the item detail drawer", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    // The drawer's first paint is its loading indicator; the panel must not
    // produce one. (There is no suiteql mock here, so if the drawer opened it
    // would sit in exactly this state.)
    expect(screen.queryByText("Loading item details…")).toBeNull();
  });

  it("the readout is inert while the not-on-PO modal is open", async () => {
    renderReceiveScreen();
    const input = screen.getByPlaceholderText("Scan item UPC...");
    scan(input, "999999999999"); // not on this PO
    await screen.findByText("Last Item Scanned is not on PO");
    expect(queryReadout("3/5 ⌄")).toBeNull(); // caret gone while blocked
    fireEvent.click(readout("3/5"));
    expect(screen.queryByText("− BIN-A (2)")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run src/modules/ItemReceipts.adjustQty.test.jsx
```

Expected: FAIL. `readout("3/5 ⌄")` throws "Unable to find an element" because no caret is rendered yet.

- [ ] **Step 3: Add the state**

In `src/modules/ItemReceipts.jsx`, immediately after the `receiptSubmitted` line (around line 78), add:

```jsx
  const [adjustingItemId, setAdjustingItemId] = useState(null); // line whose adjust panel is open; intentionally NOT persisted
```

Do **not** add `adjustingItemId` to the auto-save `useEffect` at line 114 — a resumed session must open with no panel.

- [ ] **Step 4: Add the toggle handler**

In `src/modules/ItemReceipts.jsx`, immediately after `dismissNotOnPO` (around line 222), add:

```jsx
  // Open/close a line's adjust panel. Blocked while the not-on-PO modal is up,
  // so the receiver deals with one thing at a time.
  const toggleAdjust = useCallback((itemId) => {
    if (notOnPO) return;
    setAdjustingItemId(p => (p === itemId ? null : itemId));
  }, [notOnPO]);
```

- [ ] **Step 5: Make the readout tappable and render the panel**

In `src/modules/ItemReceipts.jsx`, inside the PO-line `.map(...)`, add this line right after `const itemBins = ...` (around line 409):

```jsx
              const canAdjust = sessionRcvd > 0 && !notOnPO;
```

Then replace this block (lines 422–427):

```jsx
                    <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 8 }}>
                      {isOver && <OverBadge />}
                      <div style={{ fontSize: 16, fontWeight: 700, ...mono, color }}>
                        {rcvd}/{ordered} {isFull && "✓"}
                      </div>
                    </div>
                  </div>
```

with:

```jsx
                    <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 8 }}>
                      {isOver && <OverBadge />}
                      <div
                        onClick={canAdjust ? (e) => { e.stopPropagation(); toggleAdjust(line.item_id); } : undefined}
                        style={{
                          fontSize: 16, fontWeight: 700, ...mono, color,
                          padding: canAdjust ? "4px 8px" : 0,
                          borderRadius: 6,
                          border: `1px solid ${canAdjust ? "rgba(255,255,255,0.15)" : "transparent"}`,
                          cursor: canAdjust ? "pointer" : "default",
                          touchAction: "manipulation",
                        }}
                      >
                        {rcvd}/{ordered} {isFull && "✓"} {canAdjust && "⌄"}
                      </div>
                    </div>
                  </div>

                  {/* Adjust panel — remove one unit, attributed to a bin. */}
                  {adjustingItemId === line.item_id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        marginTop: 8, padding: 8, borderRadius: 8,
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase",
                        letterSpacing: 0.5, fontWeight: 700, marginBottom: 6 }}>
                        Remove one from
                      </div>
                      {itemBins.map(b => (
                        <button
                          key={b.bin}
                          onClick={(e) => { e.stopPropagation(); removeOneUnit(line.item_id, b.bin); }}
                          style={{ ...S.btnSm, display: "block", width: "100%", minHeight: 44,
                            marginBottom: 6, textAlign: "left", fontSize: 14, ...mono }}
                        >
                          {`− ${b.bin} (${b.qty})`}
                        </button>
                      ))}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setAdjustingItemId(null);
                          setTimeout(() => scanRef.current?.focus(), 50);
                        }}
                        style={{ ...S.btnSm, display: "block", width: "100%", minHeight: 40, fontSize: 13 }}
                      >
                        Done
                      </button>
                    </div>
                  )}
```

Note the closing `</div>` of the inner flex row moved above the panel — the panel is a sibling of that flex row, both inside the line's outer row `<div>`.

`removeOneUnit` does not exist yet; Task 2 adds it. The tests in this task never tap a bin button, so they pass without it — but the module will not compile if you reference an undefined variable, so add this temporary stub directly after `toggleAdjust`:

```jsx
  const removeOneUnit = useCallback((itemId, bin) => {}, []); // implemented in Task 2
```

- [ ] **Step 6: Run the test and verify it passes**

```bash
npx vitest run src/modules/ItemReceipts.adjustQty.test.jsx
```

Expected: PASS, 9 tests.

- [ ] **Step 7: Run the full suite for regressions**

```bash
npm test
```

Expected: PASS. Pay attention to `src/modules/ItemReceipts.notOnPO.test.jsx` — it asserts on the same screen.

- [ ] **Step 8: Commit**

```bash
git add src/modules/ItemReceipts.jsx src/modules/ItemReceipts.adjustQty.test.jsx
git commit -m "feat: tappable qty readout opens a per-line adjust panel in receiving"
```

---

### Task 2: Removing a unit from a bin

**Files:**
- Modify: `src/modules/ItemReceipts.adjustQty.test.jsx` (append a describe block)
- Modify: `src/modules/ItemReceipts.jsx` (replace the Task 1 stub)

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `src/modules/ItemReceipts.adjustQty.test.jsx`, after the existing one. It reuses `renderReceiveScreen`, `readout`, `queryReadout` and `norm` from Task 1.

```jsx
// The "N of M items" progress readout. Function matcher because the span has
// multiple text children, and ancestors would also regex-match textContent.
const progressText = () =>
  screen.getByText((_, el) => el.tagName === "SPAN" && /of 11 items$/.test(el.textContent)).textContent;

describe("removing a unit", () => {
  it("drops the line total and the bin count by one", () => {
    renderReceiveScreen();
    expect(progressText()).toBe("6 of 11 items");
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-A (2)"));
    expect(progressText()).toBe("5 of 11 items");
    expect(readout("2/5 ⌄")).toBeTruthy();
    expect(screen.getByText("− BIN-A (1)")).toBeTruthy();
  });

  it("only touches the bin that was tapped", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-B (1)"));
    // BIN-A untouched at 2, BIN-B emptied and gone from the row summary.
    expect(screen.getByText("BIN-A(2)")).toBeTruthy();
    expect(readout("2/5 ⌄")).toBeTruthy();
  });

  it("removes a bin from the panel and the row summary once it empties", () => {
    renderReceiveScreen();
    expect(screen.getByText("BIN-A(2), BIN-B(1)")).toBeTruthy();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-B (1)"));
    expect(screen.queryByText("− BIN-B (1)")).toBeNull();
    expect(screen.queryByText("− BIN-B (0)")).toBeNull();
    expect(screen.getByText("BIN-A(2)")).toBeTruthy();
  });

  it("closes the panel and drops the caret when the line reaches zero", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-B (1)"));
    fireEvent.click(screen.getByText("− BIN-A (2)"));
    fireEvent.click(screen.getByText("− BIN-A (1)"));
    expect(screen.queryByText("Done")).toBeNull();
    expect(queryReadout("0/5 ⌄")).toBeNull();
    expect(readout("0/5")).toBeTruthy();
    expect(progressText()).toBe("3 of 11 items");
  });

  it("persists the correction to the saved session", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-A (2)"));
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    expect(saved.receivedItems["555"]).toBe(2);
    expect(saved.binItems["BIN-A::555"]).toBe(1);
    expect(saved.adjustingItemId).toBeUndefined();
  });

  // Scan focus is THE hazard in this feature: every panel handler calls
  // stopPropagation, which stops useScanRefocus's document listener from
  // firing, so each one has to refocus the input itself. This was missed twice
  // during Task 1 and no DOM-presence assertion can catch it — a receiver just
  // finds their scanner has stopped working, with nothing on screen to explain
  // why. These two tests pin it.
  it("restores scan focus after removing a unit", async () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-A (2)"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByPlaceholderText("Scan item UPC..."))
    );
  });

  it("restores scan focus when removing the last unit closes the panel", async () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-B (1)"));
    fireEvent.click(screen.getByText("− BIN-A (2)"));
    fireEvent.click(screen.getByText("− BIN-A (1)"));
    expect(screen.queryByText("Done")).toBeNull(); // panel gone
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByPlaceholderText("Scan item UPC..."))
    );
  });
});
```

`waitFor` must be added to the `@testing-library/react` import at the top of the file. It polls on real timers until the handler's `setTimeout(..., 50)` fires.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run src/modules/ItemReceipts.adjustQty.test.jsx
```

Expected: FAIL on the new tests — `progressText()` still returns `"6 of 11 items"` after the tap, and the focus assertions time out, because `removeOneUnit` still only calls `refocusScan()`.

- [ ] **Step 3: Implement removeOneUnit**

In `src/modules/ItemReceipts.jsx`, replace the stub

```jsx
  const removeOneUnit = useCallback((itemId, bin) => {}, []); // implemented in Task 2
```

with:

```jsx
  // Take one unit of `itemId` back off `bin`. Session state only — nothing
  // reaches NetSuite until Create Receipt. Emptied keys are deleted rather than
  // left at 0, so the bin drops out of the row summary, the adjust panel, and
  // the receipt payload built by getItemBinAssignments.
  const removeOneUnit = useCallback((itemId, bin) => {
    const binKey = `${bin}::${itemId}`;
    if (!binItems[binKey]) return;

    const nextBinItems = { ...binItems };
    if (nextBinItems[binKey] <= 1) delete nextBinItems[binKey];
    else nextBinItems[binKey] -= 1;

    const nextReceived = { ...receivedItems };
    const q = (nextReceived[itemId] || 0) - 1;
    if (q <= 0) delete nextReceived[itemId];
    else nextReceived[itemId] = q;

    setBinItems(nextBinItems);
    setReceivedItems(nextReceived);

    // Nothing left to adjust on this line — close the panel. Either way the
    // scanner has to be refocused, because the bin button's stopPropagation
    // kept useScanRefocus from firing.
    if (Object.keys(nextBinItems).some(k => k.endsWith(`::${itemId}`))) refocusScan();
    else closeAdjust();

    beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
  }, [binItems, receivedItems, closeAdjust, refocusScan]);
```

Both maps are read from the closure and written as plain objects rather than one closure read and one functional update. React 18 flushes discrete click events synchronously, so a fast double-tap cannot interleave here — but keeping one style makes that easy to see, and `nextBinItems` has to be a concrete value anyway to decide whether the panel closes.

`refocusScan` and `closeAdjust` were added to `ItemReceipts.jsx` during Task 1's review fixes; reuse them rather than re-inlining `setAdjustingItemId(null)` and the `setTimeout` focus call.

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx vitest run src/modules/ItemReceipts.adjustQty.test.jsx
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ItemReceipts.jsx src/modules/ItemReceipts.adjustQty.test.jsx
git commit -m "feat: remove a scanned unit from a chosen bin while receiving"
```

---

### Task 3: Over-receipt flags clear

**Files:**
- Modify: `src/modules/ItemReceipts.adjustQty.test.jsx` (append a describe block)

No production code changes. This task proves the behaviour that made the feature necessary — that correcting a double scan actually clears the over-receipt NetSuite was rejecting — and locks it against regression.

The receipt payload is not asserted here. `getItemBinAssignments` derives bins with the same `k.endsWith("::" + itemId)` filter the row summary uses, so Task 2's "bin disappears from the row summary" already exercises that logic; asserting the payload would mean mocking `fetch` in a UI test file for no additional coverage.

- [ ] **Step 1: Write the test**

Append to `src/modules/ItemReceipts.adjustQty.test.jsx`:

```jsx
// The over-receipt banner text spans several nodes, so match on the div's
// own textContent rather than a single text node.
const overBanner = () =>
  screen.queryAllByText((_, el) =>
    el && el.tagName === "DIV" && /^⚠ \d+ items? over expected quantity$/.test(el.textContent.trim())
  ).length > 0;

describe("over-receipt correction", () => {
  it("BOOT-1 starts over-received", () => {
    renderReceiveScreen();
    expect(screen.getByText("OVER")).toBeTruthy();
    expect(overBanner()).toBe(true);
  });

  it("removing the extra unit clears the badge and the banner", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/2 ⌄"));
    fireEvent.click(screen.getByText("− BIN-A (3)"));
    expect(screen.queryByText("OVER")).toBeNull();
    expect(overBanner()).toBe(false);
    expect(readout("2/2 ✓ ⌄")).toBeTruthy();
  });

  it("leaves the other line's over-status alone", () => {
    renderReceiveScreen();
    fireEvent.click(readout("3/5 ⌄"));
    fireEvent.click(screen.getByText("− BIN-A (2)"));
    // GLV-1 was never over; BOOT-1 still is.
    expect(screen.getByText("OVER")).toBeTruthy();
    expect(overBanner()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run src/modules/ItemReceipts.adjustQty.test.jsx
```

Expected: PASS, 19 tests. These assert emergent behaviour, so they should pass without new code. If the second test fails on `readout("2/2 ✓ ⌄")`, check that the readout renders the `✓` and the `⌄` with a space between them as written in Task 1 Step 5 — the `norm` helper strips whitespace, so only the character order matters.

- [ ] **Step 3: Run the full suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/ItemReceipts.adjustQty.test.jsx
git commit -m "test: correcting an over-scan clears the over-receipt flags"
```

---

## Manual Verification

Automated tests do not cover the handheld's scanner focus behaviour. After Task 3, run the app and confirm by hand:

- [ ] `npm run dev`, open Item Receipts, scan a PO, scan a bin, scan an item three times.
- [ ] Tap the qty readout. Panel opens; the bin and its count are correct.
- [ ] Tap the bin row. Count drops, a confirmation beep fires, and the cursor is back in the scan input — type a character and confirm it lands in the scan box, not nowhere.
- [ ] Tap the readout again to close the panel without removing anything, then type a character — it must land in the scan box. (This path closes the panel via `toggleAdjust`, which is the one most likely to leave the scanner dead.)
- [ ] Tap the panel's background — the padding around the buttons, or the "Remove one from" label — then type a character. It must land in the scan box.
- [ ] Tap Done. Panel closes, scan input is focused again.
- [ ] Over-scan a line, then remove **two** units with the panel open. The list sorts fully-received lines to the bottom (`ItemReceipts.jsx:395`), so the row can re-sort mid-correction — confirm the row and its open panel don't jump somewhere surprising under your finger.
- [ ] Tap the row (not the readout). The item detail drawer still opens as before. It may error with "NetSuite 500" — that is the pre-existing bug tracked separately, not a regression from this work.
- [ ] Refresh the page, tap Resume Session. The corrected counts come back and no panel is open.

## Rollout Note

The persisted session shape is unchanged, so a session already saved on a handheld survives this deploy. The stuck 26-scan session that prompted this work can be resumed and corrected in place — do not clear it before shipping.
