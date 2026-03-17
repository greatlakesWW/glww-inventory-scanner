import { useState, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════
export const suiteql = async (query, limit = 1000) => {
  const resp = await fetch("/api/suiteql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);
  return data.items || [];
};

export const suiteqlAll = async (query, onProgress) => {
  const PAGE = 1000;
  let offset = 0;
  let allItems = [];
  let hasMore = true;

  while (hasMore) {
    const resp = await fetch("/api/suiteql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: PAGE, offset }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);

    const items = data.items || [];
    allItems = allItems.concat(items);
    hasMore = data.hasMore === true && items.length > 0;
    offset += items.length;

    if (onProgress) onProgress(allItems.length, data.totalResults);
    if (offset > 50000) break; // safety limit
  }
  return allItems;
};

export const nsRecord = async (method, path, body = null) => {
  const resp = await fetch("/api/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, path, body }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);
  return data;
};

// ═══════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════
export const beep = (freq, dur = 0.12, type = "sine") => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq; o.type = type; g.gain.value = 0.15;
    o.start(); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.stop(ctx.currentTime + dur);
  } catch (e) { }
};
export const beepOk = () => beep(880);
export const beepWarn = () => beep(220, 0.25, "square");
export const beepBin = () => { beep(440); setTimeout(() => beep(660), 100); };
export const beepExtra = () => { beep(330, 0.15, "square"); setTimeout(() => beep(330, 0.15, "square"), 200); setTimeout(() => beep(330, 0.15, "square"), 400); };

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════
export const ST = {
  matched: { l: "Match", c: "#22c55e", bg: "rgba(34,197,94,0.1)", bc: "rgba(34,197,94,0.35)" },
  variance: { l: "Variance", c: "#f59e0b", bg: "rgba(245,158,11,0.1)", bc: "rgba(245,158,11,0.35)" },
  review: { l: "Review", c: "#ef4444", bg: "rgba(239,68,68,0.1)", bc: "rgba(239,68,68,0.35)" },
  unexpected: { l: "Extra", c: "#a78bfa", bg: "rgba(167,139,250,0.1)", bc: "rgba(167,139,250,0.35)" },
};

export const Badge = ({ s }) => {
  const st = ST[s];
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
      color: st.c, background: st.bg, border: `1px solid ${st.bc}`,
    }}>{st.l}</span>
  );
};

// ═══════════════════════════════════════════════════════════
// STYLES (5.5" mobile-first)
// ═══════════════════════════════════════════════════════════
export const FONT = `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap');`;
export const mono = { fontFamily: "'JetBrains Mono', monospace" };
export const S = {
  root: { minHeight: "100vh", background: "#0a0e17", color: "#e2e8f0", fontFamily: "'DM Sans', sans-serif", fontSize: 14, WebkitTapHighlightColor: "transparent" },
  hdr: { background: "#111827", borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 50 },
  card: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16, marginBottom: 10 },
  btn: { background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8, padding: "14px 20px", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%", minHeight: 48, touchAction: "manipulation" },
  btnSec: { background: "rgba(255,255,255,0.08)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "12px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%", minHeight: 48, touchAction: "manipulation" },
  btnSm: { background: "rgba(255,255,255,0.08)", color: "#94a3b8", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", minHeight: 36, touchAction: "manipulation" },
  inp: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "14px 16px", fontSize: 16, color: "#e2e8f0", fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box", minHeight: 48 },
  lbl: { display: "block", fontSize: 11, fontWeight: 600, color: "#94a3b8", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  err: { padding: "12px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, fontSize: 13, color: "#f87171", marginBottom: 10 },
  load: { padding: "12px 14px", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 8, fontSize: 13, color: "#93c5fd", marginBottom: 10, textAlign: "center" },
};

export const Logo = () => (
  <div style={{ width: 28, height: 28, background: "#3b82f6", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", ...mono }}>GW</div>
);

// ═══════════════════════════════════════════════════════════
// SESSION PERSISTENCE (parameterized by key)
// ═══════════════════════════════════════════════════════════
export const loadSession = (key) => { try { const r = localStorage.getItem(key); if (r) return JSON.parse(r); } catch (e) { } return null; };
export const saveSession = (key, d) => { try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) { } };
export const clearSession = (key) => { try { localStorage.removeItem(key); } catch (e) { } };

// ═══════════════════════════════════════════════════════════
// SHARED COMPONENT: ScanInput
// ═══════════════════════════════════════════════════════════
export const ScanInput = ({ onScan, placeholder = "Scan...", flash = null, inputRef }) => {
  const localRef = useRef(null);
  const ref = inputRef || localRef;

  const flashColor = flash === "ok" ? "rgba(34,197,94,0.5)"
    : flash === "warn" ? "rgba(245,158,11,0.5)"
    : flash === "extra" ? "rgba(167,139,250,0.6)"
    : flash === "bin" ? "rgba(99,102,241,0.5)"
    : "rgba(255,255,255,0.12)";

  return (
    <input
      ref={ref}
      style={{
        ...S.inp,
        fontSize: 20,
        textAlign: "center",
        ...mono,
        borderColor: flashColor,
        transition: "border-color 0.2s",
      }}
      placeholder={placeholder}
      autoFocus
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      inputMode="none"
      onKeyDown={e => {
        if (e.key === "Enter") {
          const val = e.target.value.trim();
          if (val) {
            onScan(val);
            e.target.value = "";
          }
          setTimeout(() => ref.current?.focus(), 50);
        }
      }}
    />
  );
};

// ═══════════════════════════════════════════════════════════
// SHARED COMPONENT: BinScanner
// ═══════════════════════════════════════════════════════════
export const BinScanner = ({ currentBin, onBinScan, onSwitchBin, binHistory, children }) => {
  const binRef = useRef(null);
  const [flash, setFlash] = useState(null);

  const handleBinScan = useCallback((val) => {
    onBinScan(val);
    beepBin();
    setFlash("bin");
    setTimeout(() => setFlash(null), 400);
  }, [onBinScan]);

  if (!currentBin) {
    return (
      <div style={{ ...S.card, background: "rgba(99,102,241,0.04)", border: "2px solid rgba(99,102,241,0.3)", textAlign: "center", padding: 20 }}>
        <div style={{ fontSize: 12, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>Scan Bin Barcode</div>
        <ScanInput inputRef={binRef} onScan={handleBinScan} placeholder="Scan bin..." flash={flash} />
        {binHistory.length > 0 && <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>Done: {binHistory.join(", ")}</div>}
      </div>
    );
  }

  return (
    <>
      <div style={{ ...S.card, background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.3)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 9, color: "#818cf8", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Bin</div>
          <div style={{ fontSize: 20, fontWeight: 700, ...mono, color: "#a5b4fc" }}>{currentBin}</div>
        </div>
        <button style={{ ...S.btnSm, marginTop: 4, fontSize: 11, padding: "4px 12px" }} onClick={onSwitchBin}>Switch Bin</button>
      </div>
      {children}
    </>
  );
};
