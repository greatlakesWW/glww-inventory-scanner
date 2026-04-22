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

// Spec §3.2 — live-merge polling cadence. Paused by visibilitychange
// so a hidden tab stops burning battery/bandwidth.
const POLL_INTERVAL_MS = 4000;

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
  // "completing" - POST /api/transfer-orders/:id/fulfill in flight  (Session 6)
  // "complete"   - fulfillment + receipt both created, session deleted (Session 6)
  // "stuck"      - fulfillment created but receipt failed (207 partial) (Session 6)
  // "error"      - non-recoverable state; UI shows Back
  const [phase, setPhase] = useState("loading");
  const [session, setSession] = useState(null);
  const [takeoverInfo, setTakeoverInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Poll telemetry — surfaced to the UI as a live-indicator dot.
  const [lastPolledAt, setLastPolledAt] = useState(null);
  const [pollError, setPollError] = useState(null);

  // Session 6 — Complete Pick terminal states.
  const [fulfillmentResult, setFulfillmentResult] = useState(null); // { fulfillmentId, receiptId, fullyFulfilled, tranId }
  const [stuckInfo, setStuckInfo] = useState(null); // { fulfillmentId, errorMessage, retryUrl }

  const deviceId = useRef(getDeviceId()).current;

  // Mirror of `busy` in a ref so the poller can read current value without
  // registering `busy` as an effect dependency (which would tear down and
  // re-spin up the interval on every PATCH).
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);

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

  // ─── Session 6 — Complete Pick (creates Item Fulfillment + Receipt in NetSuite) ───
  // Flips to a terminal phase ("complete" on full success, "stuck" on 207
  // partial_success). "error" status is surfaced but phase stays "active"
  // so the picker can retry without losing scan state.
  const completeFulfill = useCallback(async () => {
    if (!session?.sessionId) throw new Error("No active session");
    if (!toId) throw new Error("Missing TO id");
    setBusy(true);
    setError(null);
    setPhase("completing");
    try {
      const resp = await fetch(
        `/api/transfer-orders/${encodeURIComponent(toId)}/fulfill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId }),
        }
      );
      const data = await readJson(resp);

      if (resp.status === 200 && data) {
        setFulfillmentResult({
          fulfillmentId: data.fulfillmentId || null,
          receiptId: data.receiptId || null,
          fullyFulfilled: !!data.fullyFulfilled,
          tranId: data.tranId || null,
        });
        setPhase("complete");
        return;
      }

      if (resp.status === 207 && data) {
        // Fulfillment succeeded, receipt failed — spec §4.6 step 13.
        setStuckInfo({
          fulfillmentId: data.fulfillmentId || null,
          errorMessage: data.errorMessage || "Item Receipt failed after fulfillment was created",
          retryUrl: data.retryUrl || null,
        });
        setPhase("stuck");
        return;
      }

      // Any other status: surface the error AND whatever NS detail we got
      // back so the picker (and anyone tailing logs) can see exactly what
      // NetSuite complained about without having to check function logs.
      let message =
        (data && typeof data === "object" && (data.error || data.message)) ||
        `API error ${resp.status}`;
      if (data && typeof data === "object" && data.details) {
        let detailStr;
        try {
          detailStr =
            typeof data.details === "string"
              ? data.details
              : JSON.stringify(data.details);
        } catch {
          detailStr = String(data.details);
        }
        if (detailStr && detailStr.length > 0) {
          message += ` — ${detailStr.slice(0, 400)}`;
        }
      }
      setError(message);
      setPhase("active");
    } catch (e) {
      setError(e.message || "Complete Pick failed");
      setPhase("active");
    } finally {
      setBusy(false);
    }
  }, [session, toId]);

  // ─── Live-merge poller (Session 5, spec §3.2 / §5 / §7) ───
  // Fires only while phase === "active" and the tab is visible. Guarded
  // by busyRef so an in-flight PATCH never races with an overlapping GET
  // response (merge rule keeps the newer updatedAt regardless, but
  // suppressing during PATCH avoids the UI flicker).
  const sessionId = session?.sessionId || null;
  const ownerName = session?.pickerName || null;
  useEffect(() => {
    if (phase !== "active" || !sessionId) return;

    let cancelled = false;
    let timer = null;
    let inFlight = false;

    const doPoll = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (busyRef.current) return;

      inFlight = true;
      try {
        const resp = await fetch(
          `/api/pick-sessions/${encodeURIComponent(sessionId)}`
        );
        if (cancelled) return;

        if (resp.status === 404) {
          // Session expired (48h TTL) or was deleted by fulfillment (Session 6+).
          setError("Session no longer exists on the server");
          setPhase("error");
          return;
        }

        const data = await readJson(resp);
        if (!resp.ok) {
          throw new Error(
            (data && typeof data === "object" && data.error) ||
              `API error ${resp.status}`
          );
        }

        // Takeover detection: if the server says someone else owns this
        // session now, stop scanning immediately. We check against the
        // closed-over ownerName (from when this effect subscribed) rather
        // than the current session.pickerName — that way a rapid self-
        // takeOver() doesn't falsely trigger this path.
        if (data?.pickerName && ownerName && data.pickerName !== ownerName) {
          setError(`Session taken over by ${data.pickerName}`);
          setPhase("error");
          return;
        }

        // Replace-if-newer merge. The PATCH response is authoritative for
        // local state; polled GETs only win when the server has moved on.
        setSession((prev) => {
          if (!prev) return data;
          const prevTs = Date.parse(prev.updatedAt) || 0;
          const nextTs = Date.parse(data?.updatedAt || "") || 0;
          if (nextTs < prevTs) return prev;
          return data;
        });

        setLastPolledAt(Date.now());
        setPollError(null);
      } catch (e) {
        if (!cancelled) setPollError(e.message || "Poll failed");
      } finally {
        inFlight = false;
      }
    };

    // Fire immediately so the indicator lights up without a 4s delay,
    // then fall into steady-state cadence.
    doPoll();
    timer = setInterval(doPoll, POLL_INTERVAL_MS);

    // Fire an extra poll right when the tab regains visibility — pickers
    // coming back from another app should see fresh state immediately.
    const onVisibility = () => {
      if (document.visibilityState === "visible") doPoll();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [phase, sessionId, ownerName]);

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
    lastPolledAt,
    pollError,
    fulfillmentResult,
    stuckInfo,
    startSession,
    takeOver,
    recordScan,
    switchBin,
    pause,
    completeFulfill,
  };
}
