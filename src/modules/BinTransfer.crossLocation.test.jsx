// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
    expect(q).toMatch(/location = 1\b/); // validated against source loc
  });

  it("validates against the selected destination location instead", async () => {
    const input = renderDestScreen();
    fireEvent.click(screen.getByRole("button", { name: "Sales Floor" }));
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    const q = suiteqlQueries().pop();
    expect(q).toMatch(/location = 3\b/);
    expect(q).not.toMatch(/location = 1\b/);
  });
});

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
    expect(suiteqlQueries().pop()).toMatch(/location = 3\b/);
  });
});

const recordCalls = () => fetchCalls.filter(c => c.url === "/api/record").map(c => c.body);

describe("submit payload branching", () => {
  it("posts a bintransfer when locations match", async () => {
    const input = renderDestScreen();
    scan(input, "F-01-0001");
    await screen.findByText("Review Transfer");
    fireEvent.click(screen.getByText("Confirm Transfer"));
    await screen.findByText("Bin Transfer Complete");

    expect(recordCalls()).toHaveLength(1);
    const [call] = recordCalls();
    expect(call.method).toBe("POST");
    expect(call.path).toBe("bintransfer");
    expect(call.body.location).toEqual({ id: "1" });
    expect(call.body.transferlocation).toBeUndefined();
    expect(call.body.memo).toBe("B-01-0001 to F-01-0001");
    const line = call.body.inventory.items[0];
    expect(line.item).toEqual({ id: "555" });
    expect(line.quantity).toBe(2);
    expect(line.adjustqtyby).toBeUndefined();
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

    expect(recordCalls()).toHaveLength(1);
    const [call] = recordCalls();
    expect(call.path).toBe("inventorytransfer");
    expect(call.body.subsidiary).toEqual({ id: "2" });
    expect(call.body.location).toEqual({ id: "1" });
    expect(call.body.transferlocation).toEqual({ id: "3" });
    expect(call.body.memo).toBe("B-01-0001 to F-01-0001");
    const line = call.body.inventory.items[0];
    expect(line.item).toEqual({ id: "555" });
    expect(line.adjustqtyby).toBe(2);
    expect(line.quantity).toBeUndefined();
    const asn = line.inventorydetail.inventoryAssignment.items[0];
    expect(asn).toEqual({ binNumber: { id: "11" }, toBinNumber: { id: "99" }, quantity: 2 });
  });
});

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
    expect(suiteqlQueries().pop()).toMatch(/location = 3\b/);
  });
});
