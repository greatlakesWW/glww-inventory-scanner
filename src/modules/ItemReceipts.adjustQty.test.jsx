// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import ItemReceipts from "./ItemReceipts";

const SESSION_KEY = "glww_item_receipts";

// A saved session already in the receive phase, so the component mounts
// straight to the item-scan screen (after clicking Resume) with no suiteql
// network calls. Four lines cover the cases this feature cares about:
//   GLV-1  (555) 3 units across TWO bins, ordered 5  -> adjustable, not over
//   BOOT-1 (777) 3 units in ONE bin,      ordered 2  -> adjustable, OVER
//   HAT-1  (999) never scanned,           ordered 4  -> not adjustable
//   SOCK-1 (111) 3/3 received on a PRIOR receipt, 0 scanned this session
//                                          ordered 3  -> not adjustable
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
    { line_id: 4, line_number: 4, item_id: 111, item_name: "Test Sock",
      ordered_qty: 3, received_qty: 3, remaining_qty: 0, sku: "SOCK-1", upc: "012345678936" },
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
  const last = hits[hits.length - 1];
  // Hits within one row are always a nested chain — the flex wrapper plus the
  // inner readout div, or just the inner div when an OVER badge makes the
  // wrapper's text differ. A hit that does not contain `last` is a *second row*
  // colliding on the same label, which would silently target the wrong row.
  if (hits.some(el => el !== last && !el.contains(last))) {
    throw new Error(`readout("${label}") matched ${hits.length} elements across rows — ambiguous`);
  }
  return last;
};
const queryReadout = (label) => {
  const hits = screen.queryAllByText((_, el) => el && norm(el.textContent) === norm(label));
  if (!hits.length) return null;
  const last = hits[hits.length - 1];
  if (hits.some(el => el !== last && !el.contains(last))) {
    throw new Error(`queryReadout("${label}") matched ${hits.length} elements across rows — ambiguous`);
  }
  return last;
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

  it("a line received on a prior receipt is not adjustable", () => {
    renderReceiveScreen();
    // 3/3 from an earlier Item Receipt, 0 scanned this session — nothing to undo.
    expect(queryReadout("3/3 ✓ ⌄")).toBeNull();
    fireEvent.click(readout("3/3 ✓"));
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("renders exactly one space before the caret", () => {
    renderReceiveScreen();
    // norm() strips whitespace, so every other assertion here is blind to this.
    expect(readout("3/5 ⌄").textContent).toBe("3/5 ⌄");
  });
});

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
