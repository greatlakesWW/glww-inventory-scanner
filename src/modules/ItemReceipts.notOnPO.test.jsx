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
