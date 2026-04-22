import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  S, FONT, ANIMATIONS, mono, fadeIn, Logo,
  ScanInput, useScanRefocus,
  PulsingDot,
  beepOk, beepWarn, beepBin,
} from "../shared";
import { usePickSession } from "./usePickSession";
import TakeoverModal from "./TakeoverModal";

// ═══════════════════════════════════════════════════════════
// PickScreen — Pick Mode scan loop (Session 4)
//
// Flow:
//   load TO detail
//   → prompt for picker name
//   → POST /api/pick-sessions (resume or 409-takeover)
//   → scan a bin → scan items → (repeat) → Pause
//
// Bin-scan resolution uses the TO's own binAvailability (already in
// the Session 2 detail payload), not a fresh SuiteQL call — the spec
// §2 wording says "query binonhand," but re-using the already-loaded
// data keeps the latency budget sane.
//
// Per-line & per-bin counts are derived inside usePickSession from
// the session event log (source of truth), so they're automatically
// consistent with whatever PATCH /api/pick-sessions returned.
// ═══════════════════════════════════════════════════════════

const ACCENT = "#6366f1";

function ageLabel(iso) {
  if (!iso) return "just now";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function PickScreen({ to, onBack }) {
  const toId = to?.id;

  // ─── Session hook (owns the KV side) ───
  const {
    phase,
    session,
    takeoverInfo,
    error: sessionError,
    busy,
    rememberedName,
    pickedByLine,
    startSession,
    takeOver,
    recordScan,
    switchBin,
    pause,
  } = usePickSession(toId);

  // ─── TO detail fetch (lines + binAvailability) ───
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState(null);

  useEffect(() => {
    if (!toId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    (async () => {
      try {
        const resp = await fetch(`/api/transfer-orders/${encodeURIComponent(toId)}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `API error ${resp.status}`);
        if (!cancelled) setDetail(data);
      } catch (e) {
        if (!cancelled) setDetailError(e.message || "Failed to load TO detail");
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toId]);

  // ─── UI-only state ───
  const [nameInput, setNameInput] = useState("");
  useEffect(() => { if (rememberedName && !nameInput) setNameInput(rememberedName); }, [rememberedName]);

  const [currentBin, setCurrentBin] = useState(null); // { binId, binNumber }
  const [flash, setFlash] = useState(null);
  const [transientError, setTransientError] = useState(null);
  const [transientWarn, setTransientWarn] = useState(null);

  const flashTimerRef = useRef(null);
  const errorTimerRef = useRef(null);
  const warnTimerRef = useRef(null);

  const doFlash = useCallback((kind) => {
    setFlash(kind);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 400);
  }, []);

  const showError = useCallback((msg) => {
    setTransientError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setTransientError(null), 3000);
  }, []);

  const showWarn = useCallback((msg) => {
    setTransientWarn(msg);
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    warnTimerRef.current = setTimeout(() => setTransientWarn(null), 3500);
  }, []);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
  }, []);

  // ─── Derived lookup maps from the TO detail ───
  // upcToLines: upc (exact string from scanner) -> array of lines that use it
  // skuToLines: sku upper-cased -> array of lines
  // binPlan:    bin number upper-cased -> Set of lineIds with stock there
  // binByNumber: bin number upper-cased -> { binId, binNumber } (first-seen across any line)
  const lookups = useMemo(() => {
    const upcToLines = {};
    const skuToLines = {};
    const binPlan = {};
    const binByNumber = {};
    if (!detail?.lines) return { upcToLines, skuToLines, binPlan, binByNumber };
    for (const line of detail.lines) {
      if (line.upc) {
        (upcToLines[String(line.upc)] ||= []).push(line);
      }
      if (line.sku) {
        (skuToLines[String(line.sku).toUpperCase()] ||= []).push(line);
      }
      for (const ba of line.binAvailability || []) {
        const key = String(ba.binNumber || "").toUpperCase();
        if (!key) continue;
        if (!binPlan[key]) binPlan[key] = new Set();
        binPlan[key].add(String(line.lineId));
        if (!binByNumber[key]) {
          binByNumber[key] = { binId: ba.binId != null ? String(ba.binId) : null, binNumber: ba.binNumber };
        }
      }
    }
    return { upcToLines, skuToLines, binPlan, binByNumber };
  }, [detail]);

  // ─── Scan handlers ───
  const binScanRef = useRef(null);
  const itemScanRef = useRef(null);

  const handleBinScan = useCallback(async (raw) => {
    const val = String(raw || "").trim();
    if (!val) return;
    const key = val.toUpperCase();
    const hit = lookups.binByNumber[key];
    if (!hit) {
      beepWarn(); doFlash("warn"); showError("Bin not on this TO");
      return;
    }
    try {
      await switchBin(hit.binId);
      setCurrentBin(hit);
      beepBin(); doFlash("bin");
      setTransientError(null); setTransientWarn(null);
    } catch (e) {
      beepWarn(); doFlash("warn"); showError(e.message || "Failed to switch bin");
    }
  }, [lookups, switchBin, doFlash, showError]);

  const handleItemScan = useCallback(async (raw) => {
    const val = String(raw || "").trim();
    if (!val) return;
    if (!currentBin) {
      beepWarn(); doFlash("warn"); showError("Scan a bin first");
      return;
    }
    const candidates =
      lookups.upcToLines[val] ||
      lookups.skuToLines[val.toUpperCase()] ||
      [];
    if (candidates.length === 0) {
      beepWarn(); doFlash("warn"); showError("Not on this TO");
      return;
    }
    const openLines = candidates.filter((l) => {
      const remaining = Number(l.qtyRemaining) || 0;
      const already = pickedByLine[String(l.lineId)] || 0;
      return already < remaining;
    });
    if (openLines.length === 0) {
      beepWarn(); doFlash("warn"); showError("Line complete");
      return;
    }
    // Pick the first open candidate. If multiple lines match the scan, a
    // future session may need smarter selection; for now this matches the
    // existing modules' behaviour.
    const line = openLines[0];

    // §6.1 warn-allow: record even if this bin doesn't carry the line.
    const binKey = currentBin.binNumber.toUpperCase();
    const expectedHere = lookups.binPlan[binKey]?.has(String(line.lineId));
    if (!expectedHere) {
      showWarn("Not expected in this bin — recording anyway");
    } else {
      setTransientWarn(null);
    }

    try {
      await recordScan(line.lineId, line.itemId, currentBin.binId, 1);
      beepOk(); doFlash("ok");
      setTransientError(null);
    } catch (e) {
      beepWarn(); doFlash("warn"); showError(e.message || "Scan failed");
    }
  }, [currentBin, lookups, pickedByLine, recordScan, doFlash, showError, showWarn]);

  // Keep scan inputs focused when their respective phase is live.
  useScanRefocus(binScanRef, phase === "active" && !currentBin);
  useScanRefocus(itemScanRef, phase === "active" && !!currentBin);

  // ─── Small presentational helpers ───
  const sortedLines = useMemo(() => {
    if (!detail?.lines) return [];
    const binKey = currentBin?.binNumber ? currentBin.binNumber.toUpperCase() : null;
    const linesInBin = binKey ? lookups.binPlan[binKey] : null;
    const clone = [...detail.lines];
    clone.sort((a, b) => {
      const rA = Number(a.qtyRemaining) || 0;
      const rB = Number(b.qtyRemaining) || 0;
      const doneA = (pickedByLine[String(a.lineId)] || 0) >= rA;
      const doneB = (pickedByLine[String(b.lineId)] || 0) >= rB;
      if (doneA !== doneB) return doneA ? 1 : -1;
      if (linesInBin) {
        const inA = linesInBin.has(String(a.lineId));
        const inB = linesInBin.has(String(b.lineId));
        if (inA !== inB) return inA ? -1 : 1;
      }
      return Number(a.lineNumber || 0) - Number(b.lineNumber || 0);
    });
    return clone;
  }, [detail, currentBin, lookups, pickedByLine]);

  // ─── Early returns by phase ───

  if (!to || !toId) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId="?" onBack={onBack} />
        <div style={{ padding: 16 }}><div style={S.err}>No transfer order selected</div></div>
      </div>
    );
  }

  if (detailLoading || phase === "loading") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId={to.tranId} onBack={onBack} />
        <div style={{ padding: 16 }}>
          <PulsingDot color={ACCENT} label="Loading TO detail..." />
        </div>
      </div>
    );
  }

  if (detailError) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId={to.tranId} onBack={onBack} />
        <div style={{ padding: 16 }}>
          <div style={S.err}>{detailError}</div>
        </div>
      </div>
    );
  }

  // ─── Name entry / starting ───
  if (phase === "name-entry" || phase === "starting") {
    const trimmed = nameInput.trim();
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId={to.tranId} onBack={onBack} />
        <div style={{ padding: "24px 16px 120px" }}>
          <div style={{ ...fadeIn, maxWidth: 420, margin: "0 auto" }}>
            <div style={{ ...S.card, padding: 24 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0", marginBottom: 6 }}>
                Who's picking?
              </div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>
                Enter your name so teammates see it on the TO list. We'll remember it on this device.
              </div>
              <input
                type="text"
                style={{ ...S.inp, marginBottom: 12 }}
                placeholder="Your name"
                value={nameInput}
                autoFocus
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && trimmed && !busy) startSession(trimmed); }}
              />
              <button
                style={{ ...S.btn, background: ACCENT, opacity: !trimmed || busy ? 0.5 : 1 }}
                disabled={!trimmed || busy}
                onClick={() => startSession(trimmed)}
              >
                {busy ? "Starting…" : "Start Picking"}
              </button>
              {sessionError && <div style={{ ...S.err, marginTop: 12 }}>{sessionError}</div>}
              {to.lockedBy && to.lockedBy !== trimmed && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "8px 10px",
                    background: "rgba(245,158,11,0.08)",
                    border: "1px solid rgba(245,158,11,0.25)",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "#f59e0b",
                  }}
                >
                  <span style={{ fontWeight: 700 }}>{to.lockedBy}</span> is currently
                  locked on this TO ({ageLabel(to.lockedAt)}). You'll be prompted to take over.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Takeover modal ───
  if (phase === "takeover" && takeoverInfo) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId={to.tranId} onBack={onBack} />
        <TakeoverModal
          lockedBy={takeoverInfo.lockedBy}
          lockedAt={takeoverInfo.lockedAt}
          busy={busy}
          onTakeOver={takeOver}
          onCancel={onBack}
        />
      </div>
    );
  }

  // ─── Paused / error terminal ───
  if (phase === "paused") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId={to.tranId} onBack={onBack} />
        <div style={{ padding: "40px 16px", textAlign: "center" }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: "50%", margin: "0 auto 16px",
              background: `${ACCENT}20`, border: `2px solid ${ACCENT}60`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 24, color: ACCENT, fontWeight: 700,
            }}
          >⏸</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>
            Session paused
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 24 }}>
            Your progress is saved. Come back from the TO list anytime.
          </div>
          <button style={{ ...S.btn, background: ACCENT, maxWidth: 280, margin: "0 auto" }} onClick={onBack}>
            Back to TO List
          </button>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header tranId={to.tranId} onBack={onBack} />
        <div style={{ padding: 16 }}>
          <div style={S.err}>{sessionError || "Something went wrong"}</div>
          <button style={{ ...S.btnSec, marginTop: 12 }} onClick={onBack}>Back to TO List</button>
        </div>
      </div>
    );
  }

  // ─── Active scanning UI ───
  const remainingCount = detail.lines.filter((l) => {
    const rem = Number(l.qtyRemaining) || 0;
    const picked = pickedByLine[String(l.lineId)] || 0;
    return picked < rem;
  }).length;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* Sticky header with Pause button */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3, ...mono }}>
            Pick: {to.tranId || `#${toId}`}
          </span>
        </div>
        <button
          onClick={async () => {
            try { await pause(); } catch { /* hook sets phase=error on takeover */ }
          }}
          disabled={busy}
          style={{ ...S.btnSm, fontSize: 12, background: "rgba(245,158,11,0.12)", color: "#f59e0b", borderColor: "rgba(245,158,11,0.3)" }}
        >
          {busy ? "…" : "⏸ Pause"}
        </button>
      </div>

      <div style={{ padding: "16px 16px 120px" }}>
        <div style={fadeIn}>

          {/* Sub-header: locations + picker pill */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              <span style={{ color: "#e2e8f0", fontWeight: 600, ...mono }}>{detail.sourceLocationName || "—"}</span>
              <span style={{ color: "#475569", margin: "0 6px" }}>→</span>
              <span style={{ color: ACCENT, fontWeight: 600, ...mono }}>{detail.destinationLocationName || "—"}</span>
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 10px",
                borderRadius: 20,
                background: `${ACCENT}15`,
                border: `1px solid ${ACCENT}30`,
                fontSize: 11,
                color: ACCENT,
                fontWeight: 600,
                ...mono,
              }}
            >
              👤 {session?.pickerName || "—"}
            </div>
          </div>

          {/* Current bin card */}
          {!currentBin ? (
            <div
              style={{
                ...S.card,
                background: `${ACCENT}08`,
                border: `2px solid ${ACCENT}40`,
                textAlign: "center",
                padding: 20,
                marginBottom: 12,
              }}
            >
              <div style={{ ...S.lbl, color: ACCENT, marginBottom: 8 }}>
                Scan a bin to begin
              </div>
              <ScanInput
                inputRef={binScanRef}
                onScan={handleBinScan}
                placeholder="Scan bin..."
                flash={flash}
              />
            </div>
          ) : (
            <div
              style={{
                ...S.card,
                background: `${ACCENT}08`,
                border: `2px solid ${ACCENT}40`,
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ ...S.lbl, color: ACCENT }}>Current Bin</div>
                  <div style={{ fontSize: 22, fontWeight: 700, ...mono, color: "#e2e8f0", letterSpacing: 0.5 }}>
                    {currentBin.binNumber}
                  </div>
                </div>
                <button
                  style={{ ...S.btnSm, fontSize: 11 }}
                  onClick={() => {
                    setCurrentBin(null);
                    setTransientError(null);
                    setTransientWarn(null);
                  }}
                >
                  Switch Bin
                </button>
              </div>
              <ScanInput
                inputRef={itemScanRef}
                onScan={handleItemScan}
                placeholder="Scan item..."
                flash={flash}
              />
            </div>
          )}

          {/* Banners */}
          {transientError && <div style={{ ...S.err, marginBottom: 8 }}>{transientError}</div>}
          {transientWarn && (
            <div
              style={{
                padding: "10px 12px",
                marginBottom: 8,
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.3)",
                borderRadius: 8,
                color: "#f59e0b",
                fontSize: 13,
              }}
            >
              {transientWarn}
            </div>
          )}
          {sessionError && <div style={{ ...S.err, marginBottom: 8 }}>{sessionError}</div>}

          {/* Progress summary */}
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, ...mono }}>
            {remainingCount} / {detail.lines.length} lines remaining
          </div>

          {/* Line list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sortedLines.map((line) => {
              const remaining = Number(line.qtyRemaining) || 0;
              const picked = pickedByLine[String(line.lineId)] || 0;
              const done = picked >= remaining;
              const binKey = currentBin?.binNumber?.toUpperCase();
              const inCurrentBin = binKey && lookups.binPlan[binKey]?.has(String(line.lineId));
              const qtyHere = inCurrentBin
                ? (line.binAvailability || []).find(
                    (b) => String(b.binNumber || "").toUpperCase() === binKey
                  )?.qtyOnHand
                : null;
              return (
                <LineRow
                  key={line.lineId}
                  line={line}
                  picked={picked}
                  done={done}
                  highlighted={!!inCurrentBin && !done}
                  qtyInCurrentBin={qtyHere}
                  currentBinKey={binKey}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────
// Internal components
// ───────────────────────────────────────────────

function Header({ tranId, onBack }) {
  return (
    <div style={S.hdr}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Logo />
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3, ...mono }}>
          Pick: {tranId || "?"}
        </span>
      </div>
      <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
    </div>
  );
}

function LineRow({ line, picked, done, highlighted, qtyInCurrentBin, currentBinKey }) {
  // "Preferred" bin = the lowest bin number (e.g., B-01-0001 before B-01-0002).
  // This matches how pickers walk the warehouse — aisle-by-aisle in order —
  // rather than chasing whichever bin holds the most stock. localeCompare with
  // numeric: true handles natural sort so B-01-0010 comes after B-01-0002
  // instead of after B-01-0001.
  const otherBins = !done
    ? (line.binAvailability || [])
        .filter((b) => b && b.binNumber)
        .filter((b) => (currentBinKey ? String(b.binNumber).toUpperCase() !== currentBinKey : true))
        .slice()
        .sort((a, b) =>
          String(a.binNumber).localeCompare(String(b.binNumber), undefined, {
            numeric: true,
            sensitivity: "base",
          })
        )
    : [];

  return (
    <div
      style={{
        ...S.card,
        padding: "10px 12px",
        marginBottom: 0,
        background: done ? "rgba(34,197,94,0.04)" : highlighted ? `${ACCENT}08` : S.card.background,
        border: done
          ? "1px solid rgba(34,197,94,0.2)"
          : highlighted
          ? `1px solid ${ACCENT}40`
          : S.card.border,
        opacity: done ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: done ? "#22c55e" : "#e2e8f0",
              ...mono,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textDecoration: done ? "line-through" : "none",
            }}
          >
            {line.sku}
          </div>
          {!done && (
            <div
              style={{
                fontSize: 11,
                color: "#94a3b8",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {line.description || ""}
            </div>
          )}
          {!done && (highlighted || otherBins.length > 0) && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 4,
              }}
            >
              {highlighted && qtyInCurrentBin != null && (
                <BinChip
                  bin={{ binNumber: "This bin", qtyOnHand: qtyInCurrentBin }}
                  current
                />
              )}
              {otherBins.slice(0, 3).map((b, i) => (
                <BinChip key={`${b.binId}-${i}`} bin={b} preferred={!highlighted && i === 0} />
              ))}
              {otherBins.length > 3 && (
                <span style={{ fontSize: 10, color: "#64748b", alignSelf: "center", ...mono }}>
                  +{otherBins.length - 3} more
                </span>
              )}
              {!highlighted && otherBins.length === 0 && (
                <span
                  style={{
                    fontSize: 10,
                    color: "#ef4444",
                    ...mono,
                    padding: "2px 8px",
                    borderRadius: 10,
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.25)",
                  }}
                >
                  No bin stock
                </span>
              )}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              ...mono,
              color: done ? "#22c55e" : picked > 0 ? ACCENT : "#475569",
            }}
          >
            {picked}/{line.qtyRemaining}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────
// BinChip — compact bin-location badge shown per line.
// `current`    = stock in the currently-scanned bin (use accent solid).
// `preferred`  = first sort candidate (most on-hand) of the remaining bins.
// ───────────────────────────────────────────────
function BinChip({ bin, current, preferred }) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.2,
    ...mono,
  };
  const style = current
    ? {
        ...base,
        color: "#fff",
        background: ACCENT,
        border: `1px solid ${ACCENT}`,
      }
    : preferred
    ? {
        ...base,
        color: ACCENT,
        background: `${ACCENT}15`,
        border: `1px solid ${ACCENT}50`,
      }
    : {
        ...base,
        color: "#94a3b8",
        background: "rgba(148,163,184,0.08)",
        border: "1px solid rgba(148,163,184,0.2)",
      };
  const qty = Number(bin.qtyOnHand) || 0;
  return (
    <span style={style}>
      📍 {bin.binNumber}
      {qty > 0 && <span style={{ opacity: 0.75 }}>·{qty}</span>}
    </span>
  );
}
