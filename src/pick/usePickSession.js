import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ═══════════════════════════════════════════════════════════
// usePickSession — session lifecycle + event-log derived state
//
// Owns the client side of /api/pick-sessions (Session 1). Exposes
// an imperative surface (startSession, recordScan, switchBin,
// pause, takeOver) and a derived view (pickedByLine, pickedByLineBin)
// so PickScreen can be mostly presentational.
//
// Polling / live merge is NOT implemented here — Session 5 will add
// a visibility-gated GET poller on top.
// ═══════════════════════════════════════════════════════════

const LS_PICKER_NAME = "glww_picker_name";
const LS_DEVICE_ID = "glww_device_id";

// Stable device id per browser — persisted once and reused. Used purely
// for event-log attribution; if localStorage is unavailable we fall
// back to an in-memory id (lost on reload, still unique per session).
function getDeviceId() {
  try {
    const existing = localStorage.getItem(LS_DEVICE_ID);
    if (existing) return existing;
    const fresh = `dev_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(LS_DEVICE_ID, fresh);
    return fresh;
  } catch {
    return `dev_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function makeClientEventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Parse JSON body; keep the response.ok flag so we can branch on status.
async function readJson(resp) {
  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function usePickSession(toId) {
  // ── phase-driven state machine ──
  // "loading"    - on mount, deciding initial phase
  // "name-entry" - waiting for the picker to submit a name
  // "starting"   - POST /api/pick-sessions in flight
  // "takeover"   - 409 received, TakeoverModal is surfaced
  // "active"     - session owned by this browser, scanning allowed
  // "paused"     - pause event acknowledged
  // "error"      - non-recoverable state; UI shows Back
  const [phase, setPhase] = useState("loading");
  const [session, setSession] = useState(null);
  const [takeoverInfo, setTakeoverInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const deviceId = useRef(getDeviceId()).current;

  // Initial phase: if we have a remembered picker name we still show
  // the name-entry card (prefilled) so the picker can type a different
  // name if they're covering for someone else. No auto-start.
  useEffect(() => {
    if (!toId) return;
    setPhase("name-entry");
  }, [toId]);

  // ─── Derived state (recomputed from session.events) ───
  const { pickedByLine, pickedByLineBin } = useMemo(() => {
    const byLine = {};
    const byLineBin = {};
    const events = Array.isArray(session?.events) ? session.events : [];
    for (const ev of events) {
      if (ev.type !== "scan") continue;
      const lid = String(ev.lineId);
      const bid = ev.binId != null ? String(ev.binId) : "";
      const qty = Number(ev.qty) || 0;
      byLine[lid] = (byLine[lid] || 0) + qty;
      const key = `${lid}::${bid}`;
      byLineBin[key] = (byLineBin[key] || 0) + qty;
    }
    return { pickedByLine: byLine, pickedByLineBin: byLineBin };
  }, [session]);

  // ─── PATCH helper ───
  // Used for scan / switch_bin / pause / take_over. Session 1's server
  // validates ownership by pickerName; take_over is the only event
  // that changes ownership.
  const patchSession = useCallback(
    async (sessionId, body) => {
      if (!sessionId) throw new Error("No session id");
      const resp = await fetch(
        `/api/pick-sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await readJson(resp);
      if (!resp.ok) {
        const message =
          (data && typeof data === "object" && (data.error || data.message)) ||
          (typeof data === "string" ? data : `API error ${resp.status}`);
        const err = new Error(message);
        err.status = resp.status;
        err.body = data;
        throw err;
      }
      return data;
    },
    []
  );

  // ─── Actions ───

  const startSession = useCallback(
    async (pickerName) => {
      const name = String(pickerName || "").trim();
      if (!name) {
        setError("Enter your name to start");
        return;
      }
      if (!toId) {
        setError("Missing TO id");
        return;
      }
      setBusy(true);
      setError(null);
      setPhase("starting");
      try {
        const resp = await fetch("/api/pick-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toId: String(toId), pickerName: name }),
        });
        const data = await readJson(resp);
        if (resp.status === 409) {
          // Locked by another picker — surface takeover UI.
          setTakeoverInfo({
            lockedBy: data?.lockedBy || "another picker",
            lockedAt: data?.lockedAt || null,
            sessionId: data?.sessionId || null,
          });
          // Stash the attempted picker name on the hook so takeOver()
          // knows who we are without requiring the caller to pass it again.
          pendingNameRef.current = name;
          setPhase("takeover");
          return;
        }
        if (!resp.ok) {
          const message =
            (data && typeof data === "object" && (data.error || data.message)) ||
            `API error ${resp.status}`;
          setError(message);
          setPhase("error");
          return;
        }
        try {
          localStorage.setItem(LS_PICKER_NAME, name);
        } catch {}
        setSession(data);
        setTakeoverInfo(null);
        setPhase("active");
      } catch (e) {
        setError(e.message || "Failed to start session");
        setPhase("error");
      } finally {
        setBusy(false);
      }
    },
    [toId]
  );

  // Remembered across renders but NOT in React state — we only need it
  // momentarily between startSession() hitting 409 and takeOver() firing.
  const pendingNameRef = useRef(null);

  const takeOver = useCallback(async () => {
    if (!takeoverInfo?.sessionId) {
      setError("Missing session id for takeover");
      setPhase("error");
      return;
    }
    const newPickerName = pendingNameRef.current;
    if (!newPickerName) {
      setError("Missing picker name for takeover");
      setPhase("error");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await patchSession(takeoverInfo.sessionId, {
        type: "take_over",
        newPickerName,
        clientEventId: makeClientEventId(),
        deviceId,
      });
      try {
        localStorage.setItem(LS_PICKER_NAME, newPickerName);
      } catch {}
      setSession(data);
      setTakeoverInfo(null);
      pendingNameRef.current = null;
      setPhase("active");
    } catch (e) {
      setError(e.message || "Takeover failed");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [takeoverInfo, deviceId, patchSession]);

  const recordScan = useCallback(
    async (lineId, itemId, binId, qty = 1) => {
      if (!session?.sessionId) throw new Error("No active session");
      setBusy(true);
      try {
        const data = await patchSession(session.sessionId, {
          type: "scan",
          pickerName: session.pickerName,
          lineId: String(lineId),
          itemId: itemId != null ? String(itemId) : null,
          binId: binId != null ? String(binId) : null,
          qty: Number(qty) || 1,
          clientEventId: makeClientEventId(),
          deviceId,
        });
        setSession(data);
      } catch (e) {
        if (e.status === 409) {
          setError("Your session was taken over by another picker");
          setPhase("error");
        }
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [session, deviceId, patchSession]
  );

  const switchBin = useCallback(
    async (binId) => {
      if (!session?.sessionId) throw new Error("No active session");
      setBusy(true);
      try {
        const data = await patchSession(session.sessionId, {
          type: "switch_bin",
          pickerName: session.pickerName,
          binId: binId != null ? String(binId) : null,
          clientEventId: makeClientEventId(),
          deviceId,
        });
        setSession(data);
      } catch (e) {
        if (e.status === 409) {
          setError("Your session was taken over by another picker");
          setPhase("error");
        }
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [session, deviceId, patchSession]
  );

  const pause = useCallback(async () => {
    if (!session?.sessionId) throw new Error("No active session");
    setBusy(true);
    try {
      const data = await patchSession(session.sessionId, {
        type: "pause",
        pickerName: session.pickerName,
        clientEventId: makeClientEventId(),
        deviceId,
      });
      setSession(data);
      setPhase("paused");
    } catch (e) {
      if (e.status === 409) {
        setError("Your session was taken over by another picker");
        setPhase("error");
      }
      throw e;
    } finally {
      setBusy(false);
    }
  }, [session, deviceId, patchSession]);

  // ─── Name prefill for the entry form ───
  const rememberedName = (() => {
    try {
      return localStorage.getItem(LS_PICKER_NAME) || "";
    } catch {
      return "";
    }
  })();

  return {
    phase,
    session,
    takeoverInfo,
    error,
    busy,
    rememberedName,
    pickedByLine,
    pickedByLineBin,
    startSession,
    takeOver,
    recordScan,
    switchBin,
    pause,
  };
}
