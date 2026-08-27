// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import BinLookup from "./BinLookup";
import { logActivity } from "../activityLog";

vi.mock("../activityLog", () => ({ logActivity: vi.fn() }));

const SESSION_KEY = "glww_bin_lookup";
const LOC_SF = { id: "3", name: "Sales Floor" };

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

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });

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
    const page1 = [itemRow("A-1", "Pants", 3)];
    const page2 = [itemRow("B-2", "Shirts", 5)];
    let call = 0;
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
        call += 1;
        if (call === 1) return { ok: true, json: async () => ({ items: page1, hasMore: true }) };
        return { ok: true, json: async () => ({ items: page2, hasMore: false }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("A-1");
    await screen.findByText("B-2");

    const queries = contentQueries();
    expect(queries.length).toBe(2);
    expect(queries[0].body.offset).toBe(0);
    expect(queries[1].body.offset).toBe(page1.length);
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

  it("clears stale bin contents when the location changes", async () => {
    contentRows = [itemRow("A-1", "Pants", 3)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    await screen.findByText("A-1");

    fireEvent.click(screen.getByText("Change Location"));
    fireEvent.click(await screen.findByRole("button", { name: /Warehouse/ }));

    expect(screen.queryByText("A-1")).toBeNull();
  });

  it("drops a superseded scan so a faster later scan is not overwritten by a slower earlier one", async () => {
    let resolveAValidate;
    const aValidateGate = new Promise(res => { resolveAValidate = res; });

    global.fetch = vi.fn(async (url, opts) => {
      const urlStr = String(url);
      fetchCalls.push({ url: urlStr, body: opts?.body ? JSON.parse(opts.body) : null });
      if (urlStr.startsWith("/api/bins/validate")) {
        if (urlStr.includes("binNumber=BIN-A")) {
          await aValidateGate;
          return { ok: true, json: async () => ({ valid: true, binId: "10", binNumber: "BIN-A" }) };
        }
        return { ok: true, json: async () => ({ valid: true, binId: "20", binNumber: "BIN-B" }) };
      }
      if (urlStr === "/api/suiteql") {
        const q = JSON.parse(opts.body).query;
        if (q.includes("ib.binnumber = 10")) {
          return { ok: true, json: async () => ({ items: [itemRow("A-SKU", "Pants", 1)], hasMore: false }) };
        }
        return { ok: true, json: async () => ({ items: [itemRow("B-SKU", "Pants", 1)], hasMore: false }) };
      }
      throw new Error(`unexpected fetch ${urlStr}`);
    });

    const input = renderScanScreen();
    scan(input, "BIN-A");
    scan(input, "BIN-B");
    await screen.findByText("B-SKU");

    resolveAValidate();
    await new Promise(r => setTimeout(r, 0));

    expect(screen.queryByText("A-SKU")).toBeNull();
    expect(screen.getByText("B-SKU")).toBeTruthy();
  });
});

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

  it("opens the item drawer when an item row is tapped", async () => {
    contentRows = [itemRow("DRAWER-1", "Pants", 3)];
    const input = renderScanScreen();
    scan(input, "F-01-0001");
    fireEvent.click(await screen.findByText("DRAWER-1"));

    await waitFor(() => {
      expect(fetchCalls.some(c =>
        c.url === "/api/suiteql" &&
        c.body.query.includes("FROM item") &&
        c.body.query.includes("item.id = DRAWER-1")
      )).toBe(true);
    });
  });
});

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
