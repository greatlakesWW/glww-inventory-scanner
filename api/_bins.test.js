import { describe, it, expect, vi } from "vitest";
import { buildBinLookupQuery, resolveBinAtLocation } from "./_bins.js";

describe("buildBinLookupQuery", () => {
  it("scopes to location, filters inactive, matches case-insensitively", () => {
    const q = buildBinLookupQuery("f-01-0002", 3);
    expect(q).toContain("UPPER(binnumber) = UPPER('f-01-0002')");
    expect(q).toContain("location = 3");
    expect(q).toContain("isinactive = 'F'");
    expect(q).toContain("FETCH FIRST 1 ROWS ONLY");
  });

  it("escapes single quotes in the bin number", () => {
    const q = buildBinLookupQuery("O'BRIEN", 3);
    expect(q).toContain("UPPER('O''BRIEN')");
  });
});

describe("resolveBinAtLocation", () => {
  it("returns shaped { binId, binNumber } on a hit", async () => {
    const runner = vi.fn().mockResolvedValue({ items: [{ id: 42, binnumber: "F-01-0002" }] });
    const bin = await resolveBinAtLocation("f-01-0002", 3, runner);
    expect(bin).toEqual({ binId: "42", binNumber: "F-01-0002" });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("returns null when no rows match", async () => {
    const runner = vi.fn().mockResolvedValue({ items: [] });
    expect(await resolveBinAtLocation("NOPE", 3, runner)).toBeNull();
  });

  it("returns null without querying on empty bin number or bad location", async () => {
    const runner = vi.fn();
    expect(await resolveBinAtLocation("", 3, runner)).toBeNull();
    expect(await resolveBinAtLocation("  ", 3, runner)).toBeNull();
    expect(await resolveBinAtLocation("F-01-0002", 0, runner)).toBeNull();
    expect(await resolveBinAtLocation("F-01-0002", "abc", runner)).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("trims whitespace from the bin number before querying", async () => {
    const runner = vi.fn().mockResolvedValue({ items: [{ id: 7, binnumber: "B-1" }] });
    await resolveBinAtLocation("  B-1  ", 3, runner);
    expect(runner.mock.calls[0][0]).toContain("UPPER('B-1')");
  });
});
