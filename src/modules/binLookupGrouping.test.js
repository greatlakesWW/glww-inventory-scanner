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
