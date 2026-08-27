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
