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
