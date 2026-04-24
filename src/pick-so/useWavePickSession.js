import { useCallback, useEffect, useRef, useState } from "react";

// ═══════════════════════════════════════════════════════════
// useWavePickSession
//
// Hook that owns the wave-pick session for SO picking. Reads
// current state from /api/so-sessions/:id and provides event
// PATCH helpers (scan, add_so, pause, take_over, complete).
//
// Idempotency: every event PATCH carries a fresh clientEventId
// so retries after a flaky network don't double-apply.
// ═══════════════════════════════════════════════════════════

const newClientEventId = () => `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export default function useWavePickSession(initialSession) {
  const [session, setSession] = useState(initialSession || null);
  const [error, setError] = useState(null);
  const deviceIdRef = useRef(null);

  if (!deviceIdRef.current) {
    try {
      const KEY = "glww_device_id";
      let d = localStorage.getItem(KEY);
      if (!d) {
        d = `dev_${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(KEY, d);
      }
      deviceIdRef.current = d;
    } catch {
      deviceIdRef.current = "dev_unknown";
    }
  }

  const sessionId = session?.sessionId;

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(`/api/so-sessions/${encodeURIComponent(sessionId)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `API ${r.status}`);
      setSession(d);
    } catch (e) {
      setError(e.message);
    }
  }, [sessionId]);

  const patch = useCallback(async (body) => {
    if (!sessionId) throw new Error("No session");
    const payload = {
      clientEventId: newClientEventId(),
      deviceId: deviceIdRef.current,
      pickerName: session?.pickerName,
      ...body,
    };
    const r = await fetch(`/api/so-sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || `API ${r.status}`);
    setSession(d);
    return d;
  }, [sessionId, session?.pickerName]);

  const recordScan = useCallback(({ itemId, binId, qty }) => {
    return patch({ type: "scan", itemId: String(itemId), binId: String(binId), qty: Number(qty) });
  }, [patch]);

  const addSO = useCallback((soId) => patch({ type: "add_so", soId: String(soId) }), [patch]);
  const removeSO = useCallback((soId) => patch({ type: "remove_so", soId: String(soId) }), [patch]);
  const markUnavailable = useCallback((itemId) => patch({ type: "mark_unavailable", itemId: String(itemId) }), [patch]);
  const undoUnavailable = useCallback((itemId) => patch({ type: "undo_unavailable", itemId: String(itemId) }), [patch]);
  const pause = useCallback(() => patch({ type: "pause" }), [patch]);

  const complete = useCallback(async () => {
    if (!sessionId) throw new Error("No session");
    const r = await fetch(`/api/so-sessions/${encodeURIComponent(sessionId)}/fulfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || `API ${r.status}`);
    return d;
  }, [sessionId]);

  return {
    session,
    error,
    refresh,
    recordScan,
    addSO,
    removeSO,
    markUnavailable,
    undoUnavailable,
    pause,
    complete,
  };
}
