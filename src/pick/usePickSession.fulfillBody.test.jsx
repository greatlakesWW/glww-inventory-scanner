// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePickSession } from "./usePickSession";

// Pin the fulfill POST body contract: { sessionId, destBinNumber }.
// The server (api/transfer-orders/[id]/fulfill.js) parses exactly these keys.

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => { fetchMock.mockReset(); localStorage.clear(); });

describe("completeFulfill body contract", () => {
  it("POSTs sessionId + destBinNumber to the fulfill endpoint", async () => {
    // Start a session so completeFulfill has a sessionId to send.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessionId: "sess_1", pickerName: "Pat", events: [], updatedAt: "2026-01-01T00:00:00Z" }),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessionId: "sess_1", pickerName: "Pat", events: [], updatedAt: "2026-01-01T00:00:00Z" }),
    });
    const { result } = renderHook(() => usePickSession("123"));
    await act(async () => { await result.current.startSession("Pat"); });

    // Fulfill call.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ fulfillmentId: "9", receiptId: "10", fullyFulfilled: true, tranId: "TO1" }),
    });
    await act(async () => { await result.current.completeFulfill("F-01-0002"); });

    const fulfillCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/fulfill"));
    expect(fulfillCall).toBeTruthy();
    expect(fulfillCall[0]).toBe("/api/transfer-orders/123/fulfill");
    expect(JSON.parse(fulfillCall[1].body)).toEqual({ sessionId: "sess_1", destBinNumber: "F-01-0002" });
  });

  it("throws before any fetch when destBinNumber is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessionId: "sess_1", pickerName: "Pat", events: [], updatedAt: "2026-01-01T00:00:00Z" }),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessionId: "sess_1", pickerName: "Pat", events: [], updatedAt: "2026-01-01T00:00:00Z" }),
    });
    const { result } = renderHook(() => usePickSession("123"));
    await act(async () => { await result.current.startSession("Pat"); });
    const callsBefore = fetchMock.mock.calls.length;

    await expect(result.current.completeFulfill()).rejects.toThrow("Missing destination bin");
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
