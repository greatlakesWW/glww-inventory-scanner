import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@vercel/kv", () => ({ kv: { set: vi.fn() } }));
vi.mock("../_kv.js", () => ({
  getSessionBySessionId: vi.fn(),
  getSessionByToId: vi.fn(),
  writeSession: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock("../_suiteql.js", () => ({ getSuiteQLConfig: vi.fn(() => ({ accountId: "TEST" })) }));
vi.mock("../_bins.js", () => ({ resolveBinAtLocation: vi.fn() }));
vi.mock("../_auth.js", () => ({ generateOAuthHeader: vi.fn(() => "OAuth test") }));

import handler from "./[id]/retry-receipt.js";
import { getSessionBySessionId } from "../_kv.js";
import { resolveBinAtLocation } from "../_bins.js";

function mockRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

const fakeResp = (status, bodyObj) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  text: async () => (bodyObj == null ? "" : JSON.stringify(bodyObj)),
});

// Routes the handler's three sequential NetSuite calls:
// GET (TO header fetch) → PATCH (shipStatus) → POST (receipt RESTlet).
function stubFetch() {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    if (opts.method === "PATCH") return fakeResp(204, null);
    if (opts.method === "POST") return fakeResp(200, { receiptId: "999" });
    return fakeResp(200, { id: "123", tranId: "TO123", transferLocation: { id: "3" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const baseSession = () => ({
  sessionId: "sess_abc",
  toId: "123",
  status: "fulfilled_pending_receipt",
  fulfillmentId: "555",
  events: [{ type: "scan", itemId: "9001", qty: 2 }],
});

const req = (body = { sessionId: "sess_abc" }) => ({
  method: "POST",
  query: { id: "123" },
  body,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NS_RESTLET_RECEIVE_TO_URL", "https://ns.example.com/restlet?script=1&deploy=1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/transfer-orders/:id/retry-receipt", () => {
  it("409s with destBinNumber guidance (never 're-run the pick') when the session has no bin", async () => {
    stubFetch();
    getSessionBySessionId.mockResolvedValue(baseSession()); // no destBinId
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("destBinNumber");
    expect(res.body.error).toContain("Do NOT re-run the pick");
    expect(res.body.error).not.toContain("Delete the stuck session");
    expect(res.body.error).not.toContain("re-run the pick's Complete step");
    expect(res.body.sessionId).toBe("sess_abc");
    expect(res.body.fulfillmentId).toBe("555");
    // Nothing was written to NetSuite
    const fetchCalls = global.fetch.mock.calls;
    expect(fetchCalls.some(([, o]) => o?.method === "PATCH" || o?.method === "POST")).toBe(false);
  });

  it("sends the session's destBinId to the receipt RESTlet", async () => {
    const fetchMock = stubFetch();
    getSessionBySessionId.mockResolvedValue({ ...baseSession(), destBinId: "77" });
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "complete", receiptId: "999", fulfillmentId: "555" });
    const postCall = fetchMock.mock.calls.find(([, o]) => o?.method === "POST");
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(postCall[1].body);
    expect(payload.destBinId).toBe("77");
    expect(payload.action).toBe("receive");
    expect(payload.lines).toEqual([{ itemId: "9001", quantity: 2 }]);
    expect(resolveBinAtLocation).not.toHaveBeenCalled();
  });

  it("resolves a body destBinNumber location-scoped when the session has no bin", async () => {
    const fetchMock = stubFetch();
    getSessionBySessionId.mockResolvedValue(baseSession());
    resolveBinAtLocation.mockResolvedValue({ binId: "88", binNumber: "F-01-0002" });
    const res = mockRes();
    await handler(req({ sessionId: "sess_abc", destBinNumber: "f-01-0002" }), res);
    expect(res.statusCode).toBe(200);
    expect(resolveBinAtLocation).toHaveBeenCalledWith("f-01-0002", 3);
    const postCall = fetchMock.mock.calls.find(([, o]) => o?.method === "POST");
    const payload = JSON.parse(postCall[1].body);
    expect(payload.destBinId).toBe("88");
  });

  it("400s when the body destBinNumber doesn't exist at the destination location", async () => {
    stubFetch();
    getSessionBySessionId.mockResolvedValue(baseSession());
    resolveBinAtLocation.mockResolvedValue(null);
    const res = mockRes();
    await handler(req({ sessionId: "sess_abc", destBinNumber: "NOPE" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('"NOPE"');
    expect(res.body.error).toContain("destination location 3");
  });
});
