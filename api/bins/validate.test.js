import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../_bins.js", () => ({ resolveBinAtLocation: vi.fn() }));
vi.mock("../_suiteql.js", () => ({ getSuiteQLConfig: vi.fn(() => ({})) }));

import handler from "./validate.js";
import { resolveBinAtLocation } from "../_bins.js";

function mockRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

const req = (query) => ({ method: "GET", query });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/bins/validate", () => {
  it("returns valid:true with binId and canonical binNumber on a hit", async () => {
    resolveBinAtLocation.mockResolvedValue({ binId: "42", binNumber: "F-01-0002" });
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "f-01-0002" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ valid: true, binId: "42", binNumber: "F-01-0002" });
    expect(resolveBinAtLocation).toHaveBeenCalledWith("f-01-0002", 3);
  });

  it("returns valid:false when the bin doesn't exist at the location", async () => {
    resolveBinAtLocation.mockResolvedValue(null);
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "NOPE" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it("400s on missing or non-numeric locationId", async () => {
    const res = mockRes();
    await handler(req({ binNumber: "B-1" }), res);
    expect(res.statusCode).toBe(400);
    const res2 = mockRes();
    await handler(req({ locationId: "abc", binNumber: "B-1" }), res2);
    expect(res2.statusCode).toBe(400);
  });

  it("400s on missing/blank binNumber", async () => {
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "   " }), res);
    expect(res.statusCode).toBe(400);
  });

  it("405s on non-GET", async () => {
    const res = mockRes();
    await handler({ method: "POST", query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it("surfaces SuiteQL failures as 500", async () => {
    resolveBinAtLocation.mockRejectedValue(new Error("SuiteQL 400: boom"));
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "B-1" }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain("boom");
  });

  it("passes through an error's own status code (e.g. 429)", async () => {
    resolveBinAtLocation.mockRejectedValue(
      Object.assign(new Error("too many requests"), { status: 429 })
    );
    const res = mockRes();
    await handler(req({ locationId: "3", binNumber: "B-1" }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toContain("too many requests");
  });

  it("200s on OPTIONS preflight", async () => {
    const res = mockRes();
    await handler({ method: "OPTIONS", query: {} }, res);
    expect(res.statusCode).toBe(200);
  });
});
