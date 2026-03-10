import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════
// API HELPER — calls our Vercel serverless function
// ═══════════════════════════════════════════════════════════
const suiteql = async (query, limit = 1000) => {
  const resp = await fetch("/api/suiteql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);
  return data.items || [];
};

// ═══════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════
const beep = (freq, dur = 0.12, type = "sine") => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq; o.type = type; g.gain.value = 0.15;
    o.start(); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.stop(ctx.currentTime + dur);
  } catch (e) {}
};
const beepOk = () => beep(880);
const beepWarn = () => beep(220, 0.25, "square");
const beepBin = () => { beep(440); setTimeout(() => beep(660), 100); };

// ═══════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════
const ST = {
  matched: { l: "Match", c: "#22c55e", bg: "rgba(34,197,94,0.1)", bc: "rgba(34,197,94,0.35)" },
  variance: { l: "Variance", c: "#f59e0b", bg: "rgba(245,158,11,0.1)", bc: "rgba(245,158,11,0.35)" },
  review: { l: "Review", c: "#ef4444", bg: "rgba(239,68,68,0.1)", bc: "rgba(239,68,68,0.35)" },
  unexpected: { l: "Extra", c: "#a78bfa", bg: "rgba(167,139,250,0.1)", bc: "rgba(167,139,250,0.35)" },
};

const Badge = ({ s }) => {
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
const FONT = `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap');`;
const mono = { fontFamily: "'JetBrains Mono', monospace" };
const S = {
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

const Logo = () => (
  <div style={{ width: 28, height: 28, background: "#3b82f6", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", ...mono }}>SC</div>
);

// ═══════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [phase, setPhase] = useState("setup");
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState(null);

  // Setup
  const [classes, setClasses] = useState([]);
  const [locations, setLocations] = useState([]);
  const [classPath, setClassPath] = useState([]);
  const [selectedClassId, setSelectedClassId] = useState(null);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [adjustAcct, setAdjustAcct] = useState("");

  // Inventory
  const [expected, setExpected] = useState([]);

  // Scanning
  const [currentBin, setCurrentBin] = useState(null);
  const [binHistory, setBinHistory] = useState([]);
  const [scans, setScans] = useState({});
  const [scanLog, setScanLog] = useState([]);
  const [flash, setFlash] = useState(null);
  const [filter, setFilter] = useState("");

  const scanRef = useRef(null);
  const binRef = useRef(null);

  // ── DERIVED ──
  const upcLookup = useMemo(() => {
    const m = {};
    expected.forEach((item) => { if (item.upc) m[item.upc] = item; });
    return m;
  }, [expected]);

  const totalScans = Object.values(scans).reduce((a, b) => a + b, 0);
  const uniqueItems = new Set(Object.keys(scans).map(k => k.includes("::") ? k.split("::")[1] : k)).size;

  const binExpected = useMemo(() => {
    if (!currentBin) return [];
    return expected.filter(i => i.bin_number && i.bin_number.toUpperCase() === currentBin.toUpperCase());
  }, [expected, currentBin]);

  const currentLevelClasses = useMemo(() => {
    const parentId = classPath.length > 0 ? classPath[classPath.length - 1].id : null;
    return classes.filter(c => parentId ? String(c.parent) === String(parentId) : !c.parent);
  }, [classes, classPath]);

  const getChildClassIds = useCallback((parentId) => {
    const ids = [String(parentId)];
    const find = (pid) => {
      classes.forEach(c => { if (String(c.parent) === String(pid)) { ids.push(String(c.id)); find(c.id); } });
    };
    find(parentId);
    return ids;
  }, [classes]);

  // ── AUTO FOCUS ──
  useEffect(() => {
    if (phase === "scanning") {
      const t = setTimeout(() => {
        if (!currentBin && binRef.current) binRef.current.focus();
        else if (currentBin && scanRef.current) scanRef.current.focus();
      }, 150);
      return () => clearTimeout(t);
    }
  }, [phase, currentBin]);

  // ── LOAD SETUP DATA ──
  const loadSetupData = async () => {
    setLoading(true); setError(null);
    try {
      setLoadMsg("Loading classes...");
      const cls = await suiteql(
        "SELECT id, name, parent FROM classification WHERE isinactive = 'F' ORDER BY name"
      );

      setLoadMsg("Loading locations...");
      const locs = await suiteql(
        "SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name"
      );

      setClasses(cls);
      setLocations(locs);
      if (cls.length === 0 && locs.length === 0) setError("No data returned. Check NetSuite connection.");
    } catch (e) {
      setError(`Failed to load: ${e.message}`);
    } finally { setLoading(false); setLoadMsg(""); }
  };

  // ── PULL INVENTORY ──
  const pullInventory = async () => {
    if (!selectedClassId) { setError("Select a class first."); return; }
    if (!selectedLocation) { setError("Select a location first."); return; }
    setLoading(true); setError(null); setLoadMsg("Pulling inventory...");

    const classIds = getChildClassIds(selectedClassId).join(",");

    try {
      const items = await suiteql(`
        SELECT
          item.id AS internalid,
          item.itemid AS sku,
          item.displayname AS itemname,
          item.upccode AS upc,
          ib.quantityonhand AS expected_qty,
          bin.binnumber AS bin_number
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        LEFT JOIN bin ON ib.binnumber = bin.id
        WHERE ib.location = ${selectedLocation.id}
          AND item.class IN (${classIds})
          AND ib.quantityonhand > 0
        ORDER BY bin.binnumber, item.itemid
      `);

      setExpected(items);
      if (items.length === 0) setError("No inventory found for this class/location.");
      setPhase("scanning");
    } catch (e) {
      setError(`Failed: ${e.message}`);
    } finally { setLoading(false); setLoadMsg(""); }
  };

  // ── SCAN HANDLERS ──
  const handleBinScan = (val) => {
    const bin = val.trim(); if (!bin) return;
    setCurrentBin(bin);
    if (!binHistory.includes(bin)) setBinHistory(p => [...p, bin]);
    beepBin(); setFlash("bin");
    setTimeout(() => { setFlash(null); scanRef.current?.focus(); }, 400);
  };

  const handleItemScan = useCallback((upc) => {
    const trimmed = upc.trim(); if (!trimmed) return;
    const key = currentBin ? `${currentBin}::${trimmed}` : trimmed;
    const match = upcLookup[trimmed];
    setScans(p => ({ ...p, [key]: (p[key] || 0) + 1 }));
    setScanLog(p => [{ upc: trimmed, bin: currentBin, time: new Date(), itemname: match?.itemname || null }, ...p]);
    if (match) { beepOk(); setFlash("ok"); } else { beepWarn(); setFlash("warn"); }
    setTimeout(() => setFlash(null), 400);
  }, [upcLookup, currentBin]);

  const undoLast = () => {
    if (scanLog.length === 0) return;
    const last = scanLog[0];
    const key = last.bin ? `${last.bin}::${last.upc}` : last.upc;
    setScans(p => { const n = { ...p }; if (n[key] > 1) n[key]--; else delete n[key]; return n; });
    setScanLog(p => p.slice(1));
  };

  const switchBin = () => { setCurrentBin(null); setTimeout(() => binRef.current?.focus(), 100); };

  // ── COMPARISON ──
  const getComparison = useCallback(() => {
    const rows = []; const done = new Set();
    expected.forEach(item => {
      const upc = item.upc || ""; const bin = item.bin_number || "";
      const key = bin ? `${bin}::${upc}` : upc;
      const sq = scans[key] || 0; const eq = Number(item.expected_qty) || 0;
      let status = "matched";
      if (sq === 0) status = "review"; else if (sq !== eq) status = "variance";
      rows.push({ ...item, upc, bin, scanned_qty: sq, expected_qty: eq, status, diff: sq - eq });
      done.add(key);
    });
    Object.entries(scans).forEach(([key, count]) => {
      if (!done.has(key)) {
        const [bin, upc] = key.includes("::") ? key.split("::") : ["", key];
        const m = upcLookup[upc];
        rows.push({ internalid: m?.internalid || "", sku: m?.sku || "", itemname: m?.itemname || `Unknown (${upc})`, upc, bin, scanned_qty: count, expected_qty: 0, status: "unexpected", diff: count });
      }
    });
    return rows;
  }, [expected, scans, upcLookup]);

  // ── CSV EXPORTS ──
  const today = () => new Date().toISOString().slice(0, 10);
  const dl = (content, filename) => {
    const b = new Blob([content], { type: "text/csv" });
    const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u; a.download = filename; a.click();
    URL.revokeObjectURL(u);
  };

  const exportDetail = () => {
    const rows = getComparison();
    const h = "Internal ID,SKU,Item Name,UPC,Bin,Expected Qty,Scanned Qty,Difference,Status\n";
    const b = rows.map(r => `"${r.internalid}","${r.sku}","${(r.itemname || "").replace(/"/g, '""')}","${r.upc}","${r.bin}",${r.expected_qty},${r.scanned_qty},${r.diff},"${ST[r.status].l}"`).join("\n");
    dl(h + b, `count_detail_${(selectedLocation?.name || "").replace(/\s+/g, "_")}_${today()}.csv`);
  };

  const exportNS = () => {
    const rows = getComparison().filter(r => r.diff !== 0);
    if (rows.length === 0) { setError("All counts match. No adjustments needed."); return; }
    const locName = (selectedLocation?.name || "location").replace(/\s+/g, "_");
    const extId = `ADJ_${locName}_${today()}`;
    const acct = adjustAcct || "Inventory Adjustments";
    const h = "External ID,Adjustment Account,Adjustment Location,Item,Adjustment: Adjust Qty By,Adjustment: Bin Number,Inventory Detail: Quantity,Inventory Detail: Bin Number\n";
    const b = rows.map(r => `"${extId}","${acct}","${selectedLocation?.name}","${r.sku || r.internalid}",${r.diff},"${r.bin}",${r.diff},"${r.bin}"`).join("\n");
    dl(h + b, `ns_import_${locName}_${today()}.csv`);
  };

  // ═══════════════════════════════════════════════════════════
  // RENDER: SETUP
  // ═══════════════════════════════════════════════════════════
  if (phase === "setup") {
    const hasData = classes.length > 0 || locations.length > 0;

    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <div style={S.hdr}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Inventory Scanner</span></div>
          <span style={{ fontSize: 10, color: "#475569", ...mono }}>v3 • Direct API</span>
        </div>
        <div style={{ padding: 16 }}>
          {!hasData && (
            <div style={S.card}>
              <p style={{ fontSize: 14, color: "#94a3b8", marginBottom: 14 }}>Connect to NetSuite to load classes and locations.</p>
              {loading && <div style={S.load}>{loadMsg}</div>}
              {error && <div style={S.err}>{error}</div>}
              <button style={S.btn} onClick={loadSetupData} disabled={loading}>{loading ? "Connecting..." : "Connect to NetSuite"}</button>
            </div>
          )}

          {/* CLASS SELECTOR */}
          {classes.length > 0 && (
            <div style={S.card}>
              <label style={S.lbl}>Class</label>
              {classPath.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10, alignItems: "center" }}>
                  <button style={{ ...S.btnSm, padding: "4px 10px", fontSize: 11 }} onClick={() => { setClassPath([]); setSelectedClassId(null); }}>All</button>
                  {classPath.map((c, i) => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: "#475569", fontSize: 12 }}>›</span>
                      <button style={{ ...S.btnSm, padding: "4px 10px", fontSize: 11, background: i === classPath.length - 1 ? "rgba(59,130,246,0.15)" : undefined, color: i === classPath.length - 1 ? "#60a5fa" : "#94a3b8", borderColor: i === classPath.length - 1 ? "rgba(59,130,246,0.3)" : undefined }} onClick={() => { setClassPath(classPath.slice(0, i + 1)); setSelectedClassId(classPath[i].id); }}>{c.name}</button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ maxHeight: 200, overflowY: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
                {currentLevelClasses.length === 0 ? (
                  <div style={{ padding: 16, textAlign: "center", color: "#475569", fontSize: 13 }}>{classPath.length > 0 ? "No sub-classes. Ready to go." : "No classes found."}</div>
                ) : currentLevelClasses.map(c => {
                  const hasKids = classes.some(ch => String(ch.parent) === String(c.id));
                  const isSel = String(selectedClassId) === String(c.id);
                  return (
                    <button key={c.id} onClick={() => { setSelectedClassId(c.id); setClassPath([...classPath, { id: c.id, name: c.name }]); }}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "14px 16px", border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)", background: isSel ? "rgba(59,130,246,0.08)" : "transparent", color: isSel ? "#60a5fa" : "#e2e8f0", fontSize: 14, fontFamily: "inherit", textAlign: "left", cursor: "pointer", minHeight: 48 }}>
                      <span>{c.name}</span>
                      {hasKids && <span style={{ color: "#475569", fontSize: 18 }}>›</span>}
                    </button>
                  );
                })}
              </div>
              {selectedClassId && <div style={{ marginTop: 8, fontSize: 12, color: "#60a5fa", ...mono }}>✓ {classPath.map(c => c.name).join(" > ")}</div>}
            </div>
          )}

          {/* LOCATION SELECTOR */}
          {locations.length > 0 && (
            <div style={S.card}>
              <label style={S.lbl}>Location</label>
              <div style={{ maxHeight: 180, overflowY: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
                {locations.map(loc => {
                  const isSel = selectedLocation?.id === loc.id;
                  return (
                    <button key={loc.id} onClick={() => setSelectedLocation(loc)}
                      style={{ display: "block", width: "100%", padding: "14px 16px", border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)", background: isSel ? "rgba(59,130,246,0.08)" : "transparent", color: isSel ? "#60a5fa" : "#e2e8f0", fontSize: 14, fontFamily: "inherit", textAlign: "left", cursor: "pointer", minHeight: 48 }}>
                      {isSel && "✓ "}{loc.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ADJ ACCOUNT */}
          {classes.length > 0 && (
            <div style={S.card}>
              <label style={S.lbl}>Adjustment Account (optional)</label>
              <input style={S.inp} value={adjustAcct} onChange={e => setAdjustAcct(e.target.value)} placeholder="Can set during NS import instead" />
            </div>
          )}

          {error && hasData && <div style={S.err}>{error}</div>}
          {loading && hasData && <div style={S.load}>{loadMsg}</div>}

          {classes.length > 0 && (<>
            <button style={{ ...S.btn, opacity: selectedClassId && selectedLocation ? 1 : 0.4, background: "#22c55e", marginBottom: 10 }}
              onClick={pullInventory} disabled={!selectedClassId || !selectedLocation || loading}>
              {loading ? "Loading..." : "Pull Inventory & Start Scanning"}
            </button>
            <button style={S.btnSec} onClick={() => { setExpected([]); setPhase("scanning"); }}>Skip — Scan Only</button>
          </>)}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: SCANNING
  // ═══════════════════════════════════════════════════════════
  if (phase === "scanning") {
    const fb = flash === "ok" ? "rgba(34,197,94,0.5)" : flash === "warn" ? "rgba(245,158,11,0.5)" : flash === "bin" ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.06)";

    const binScans = {};
    if (currentBin) Object.entries(scans).forEach(([k, v]) => { if (k.startsWith(`${currentBin}::`)) binScans[k.split("::")[1]] = v; });
    const binItemsTotal = binExpected.reduce((a, i) => a + (Number(i.expected_qty) || 0), 0);
    const binScannedTotal = Object.values(binScans).reduce((a, b) => a + b, 0);

    return (
      <div style={S.root} onClick={() => { if (!currentBin) binRef.current?.focus(); else scanRef.current?.focus(); }}>
        <style>{FONT}</style>
        <div style={S.hdr}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Logo />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Scanning</div>
              <div style={{ fontSize: 10, color: "#64748b", ...mono }}>{classPath.map(c => c.name).join(" > ")}</div>
            </div>
          </div>
          <button style={{ ...S.btnSm, background: "#22c55e", color: "#fff", borderColor: "#22c55e" }} onClick={() => { setError(null); setPhase("review"); }}>Finalize</button>
        </div>
        <div style={{ padding: "10px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            {[["Scans", totalScans], ["Items", uniqueItems], ["Bins", binHistory.length]].map(([l, v]) => (
              <div key={l} style={{ ...S.card, padding: "8px 12px", marginBottom: 0, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{l}</div>
                <div style={{ fontSize: 22, fontWeight: 700, ...mono }}>{v}</div>
              </div>
            ))}
          </div>

          {/* BIN SCANNER */}
          {!currentBin ? (
            <div style={{ ...S.card, background: "rgba(99,102,241,0.04)", border: "2px solid rgba(99,102,241,0.3)", textAlign: "center", padding: 20 }}>
              <div style={{ fontSize: 12, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>Scan Bin Barcode</div>
              <input ref={binRef} style={{ ...S.inp, fontSize: 20, textAlign: "center", ...mono }} placeholder="Scan bin..." autoFocus
                onKeyDown={e => { if (e.key === "Enter") { handleBinScan(e.target.value); e.target.value = ""; } }} />
              {binHistory.length > 0 && <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>Done: {binHistory.join(", ")}</div>}
            </div>
          ) : (<>
            {/* ACTIVE BIN */}
            <div style={{ ...S.card, background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.3)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 9, color: "#818cf8", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Bin</div>
                <div style={{ fontSize: 20, fontWeight: 700, ...mono, color: "#a5b4fc" }}>{currentBin}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>
                  <span style={{ ...mono, fontWeight: 700, color: binScannedTotal === binItemsTotal && binItemsTotal > 0 ? "#22c55e" : "#e2e8f0" }}>{binScannedTotal}</span>
                  <span> / {binItemsTotal}</span>
                </div>
                <button style={{ ...S.btnSm, marginTop: 4, fontSize: 11, padding: "4px 12px" }} onClick={switchBin}>Switch Bin</button>
              </div>
            </div>

            {/* ITEM SCANNER */}
            <div style={{ ...S.card, border: `2px solid ${fb}`, transition: "all 0.2s", background: flash === "ok" ? "rgba(34,197,94,0.04)" : flash === "warn" ? "rgba(245,158,11,0.04)" : "transparent", textAlign: "center", padding: 16 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700, marginBottom: 8, transition: "color 0.2s", color: flash === "ok" ? "#22c55e" : flash === "warn" ? "#f59e0b" : "#94a3b8" }}>
                {flash === "ok" ? "✓ Recognized" : flash === "warn" ? "⚠ Unknown UPC" : "Scan Items"}
              </div>
              <input ref={scanRef} style={{ ...S.inp, fontSize: 20, textAlign: "center", ...mono }} placeholder="Scan item..." autoFocus
                onKeyDown={e => { if (e.key === "Enter") { handleItemScan(e.target.value); e.target.value = ""; } }} />
              {scanLog.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: "#64748b" }}>Last: <span style={mono}>{scanLog[0]?.upc}</span>{scanLog[0]?.itemname && <span> — {scanLog[0].itemname}</span>}</div>}
              <button style={{ ...S.btnSm, marginTop: 8, fontSize: 11 }} onClick={undoLast} disabled={scanLog.length === 0}>Undo Last</button>
            </div>

            {/* BIN EXPECTED LIST */}
            {binExpected.length > 0 && (
              <div style={{ ...S.card, padding: 0 }}>
                <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Expected in {currentBin} ({binExpected.length} items)
                </div>
                <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  {binExpected.map((item, i) => {
                    const sq = binScans[item.upc] || 0;
                    const eq = Number(item.expected_qty) || 0;
                    const done = sq >= eq;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.03)", background: done ? "rgba(34,197,94,0.04)" : "transparent", opacity: done ? 0.6 : 1 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: done ? "line-through" : "none", color: done ? "#22c55e" : "#e2e8f0" }}>{item.itemname || item.sku}</div>
                          <div style={{ fontSize: 11, color: "#64748b", ...mono }}>{item.upc}</div>
                        </div>
                        <div style={{ textAlign: "right", marginLeft: 12 }}>
                          <span style={{ ...mono, fontSize: 16, fontWeight: 700, color: done ? "#22c55e" : sq > 0 ? "#f59e0b" : "#475569" }}>{sq}</span>
                          <span style={{ fontSize: 12, color: "#64748b" }}> / {eq}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>)}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button style={{ ...S.btnSec, padding: "10px 14px" }} onClick={() => setPhase("setup")}>← Setup</button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: REVIEW
  // ═══════════════════════════════════════════════════════════
  const comparison = getComparison();
  const stats = { total: comparison.length, matched: comparison.filter(r => r.status === "matched").length, variance: comparison.filter(r => r.status === "variance").length, review: comparison.filter(r => r.status === "review").length, unexpected: comparison.filter(r => r.status === "unexpected").length };
  const filtered = comparison.filter(r => !filter || r.status === filter);
  const adjCount = comparison.filter(r => r.diff !== 0).length;

  return (
    <div style={S.root}>
      <style>{FONT}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Logo /><span style={{ fontSize: 14, fontWeight: 700 }}>Review</span></div>
        <button style={S.btnSm} onClick={() => setPhase("scanning")}>← Scan</button>
      </div>
      <div style={{ padding: "10px 16px" }}>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, ...mono }}>{classPath.map(c => c.name).join(" > ")} • {selectedLocation?.name}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 10 }}>
          {[["All", stats.total, "#e2e8f0", ""], ["OK", stats.matched, "#22c55e", "matched"], ["Var", stats.variance, "#f59e0b", "variance"], ["Rev", stats.review, "#ef4444", "review"], ["New", stats.unexpected, "#a78bfa", "unexpected"]].map(([l, v, c, f]) => (
            <div key={l} onClick={() => setFilter(filter === f ? "" : f)} style={{ ...S.card, padding: "6px 4px", marginBottom: 0, textAlign: "center", cursor: "pointer", opacity: filter && filter !== f ? 0.35 : 1, border: filter === f ? `1px solid ${c}` : "1px solid rgba(255,255,255,0.06)", transition: "all 0.15s" }}>
              <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.3, fontWeight: 600 }}>{l}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: c, ...mono }}>{v}</div>
            </div>
          ))}
        </div>
        {error && <div style={S.err}>{error}</div>}
        <div style={{ padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.2)", color: "#93c5fd", marginBottom: 10 }}>
          <strong>{adjCount}</strong> item{adjCount !== 1 ? "s" : ""} need adjustment. Import via Transactions › Inventory Adjustment › <strong>Add</strong>.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <button style={S.btnSec} onClick={exportDetail}>Export Detail</button>
          <button style={{ ...S.btn, padding: "12px 16px" }} onClick={exportNS}>NS Import CSV</button>
        </div>
        <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 380px)" }}>
            {filtered.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.03)", background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <Badge s={r.status} />
                    {r.bin && <span style={{ fontSize: 10, color: "#818cf8", ...mono }}>{r.bin}</span>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.itemname || r.sku}</div>
                  <div style={{ fontSize: 10, color: "#64748b", ...mono }}>{r.sku} • {r.upc}</div>
                </div>
                <div style={{ textAlign: "right", marginLeft: 12, whiteSpace: "nowrap" }}>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}><span style={mono}>{r.scanned_qty}</span> / <span style={mono}>{r.expected_qty}</span></div>
                  <div style={{ ...mono, fontSize: 16, fontWeight: 700, color: r.diff === 0 ? "#22c55e" : r.diff > 0 ? "#f59e0b" : "#ef4444" }}>{r.diff > 0 ? `+${r.diff}` : r.diff}</div>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#475569" }}>No items match filter.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
