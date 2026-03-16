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

// Paginated version — fetches ALL rows across multiple pages
const suiteqlAll = async (query, onProgress) => {
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
  } catch (e) { }
};
const beepOk = () => beep(880);
const beepWarn = () => beep(220, 0.25, "square");
const beepBin = () => { beep(440); setTimeout(() => beep(660), 100); };
const beepExtra = () => { beep(330, 0.15, "square"); setTimeout(() => beep(330, 0.15, "square"), 200); setTimeout(() => beep(330, 0.15, "square"), 400); };

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
// HELPERS
// ═══════════════════════════════════════════════════════════
const getSkuPrefix = (sku) => {
  if (!sku) return "";
  const idx = sku.indexOf("-");
  return idx > 0 ? sku.substring(0, idx).toUpperCase() : sku.toUpperCase();
};

// ═══════════════════════════════════════════════════════════
// SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════
const SESSION_KEY = "glww_scanner_session";
const loadSession = () => { try { const r = localStorage.getItem(SESSION_KEY); if (r) return JSON.parse(r); } catch (e) { } return null; };
const saveSession = (d) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(d)); } catch (e) { } };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch (e) { } };

// ═══════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const saved = useRef(loadSession()).current;

  const [phase, setPhase] = useState(saved?.phase || "home");
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState(null);

  // Setup
  const [classes, setClasses] = useState(saved?.classes || []);
  const [locations, setLocations] = useState(saved?.locations || []);
  const [classPath, setClassPath] = useState(saved?.classPath || []);
  const [selectedClassId, setSelectedClassId] = useState(saved?.selectedClassId || null);
  const [selectedLocation, setSelectedLocation] = useState(saved?.selectedLocation || null);
  const [adjustAcct, setAdjustAcct] = useState(saved?.adjustAcct || "");

  // Inventory
  const [expected, setExpected] = useState(saved?.expected || []);
  const [selectedPrefixes, setSelectedPrefixes] = useState(saved?.selectedPrefixes ?? null);
  const [styleSearch, setStyleSearch] = useState("");
  const [locationBinMap, setLocationBinMap] = useState(saved?.locationBinMap || {}); // {binName: binId} for ALL bins at location
  const [noBinItems, setNoBinItems] = useState([]);
  const [showNoBin, setShowNoBin] = useState(false);

  // Scanning
  const [currentBin, setCurrentBin] = useState(saved?.currentBin || null);
  const [binHistory, setBinHistory] = useState(saved?.binHistory || []);
  const [scans, setScans] = useState(saved?.scans || {});
  const [scanLog, setScanLog] = useState(() => saved?.scanLog ? saved.scanLog.map(s => ({ ...s, time: new Date(s.time) })) : []);
  const [flash, setFlash] = useState(null);
  const [filter, setFilter] = useState("");
  const [emailTo, setEmailTo] = useState(saved?.emailTo || "");

  const scanRef = useRef(null);
  const binRef = useRef(null);

  // Lookup mode
  const [lookupResults, setLookupResults] = useState([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupHistory, setLookupHistory] = useState([]);
  const lookupRef = useRef(null);

  // ── DERIVED ──
  const upcLookup = useMemo(() => {
    const m = {};
    expected.forEach((item) => { if (item.upc) m[item.upc] = item; });
    return m;
  }, [expected]);

  const totalScans = Object.values(scans).reduce((a, b) => a + b, 0);
  const uniqueItems = new Set(Object.keys(scans).map(k => k.includes("::") ? k.split("::")[1] : k)).size;

  // FIXED: Filter binExpected by selected prefixes
  const binExpected = useMemo(() => {
    if (!currentBin) return [];
    const prefixSet = selectedPrefixes ? new Set(selectedPrefixes.map(p => p.toUpperCase())) : null;
    return expected.filter(i => {
      if (!i.bin_number || i.bin_number.toUpperCase() !== currentBin.toUpperCase()) return false;
      if (prefixSet && !prefixSet.has(getSkuPrefix(i.sku))) return false;
      return true;
    });
  }, [expected, currentBin, selectedPrefixes]);

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

  // ── AUTO-SAVE SESSION ──
  useEffect(() => {
    if (phase === "home" || phase === "lookup") return;
    if (phase === "setup" && classes.length === 0) return;
    saveSession({
      phase, classes, locations, classPath, selectedClassId,
      selectedLocation, adjustAcct, expected, selectedPrefixes, locationBinMap, currentBin,
      binHistory, scans, scanLog, emailTo,
    });
  }, [phase, classes, locations, classPath, selectedClassId,
    selectedLocation, adjustAcct, expected, selectedPrefixes, locationBinMap, currentBin,
    binHistory, scans, scanLog, emailTo]);

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

    const classFilter = selectedClassId === "ALL"
      ? ""
      : `AND item.class IN (${getChildClassIds(selectedClassId).join(",")})`;

    try {
      const items = await suiteqlAll(`
        SELECT
          item.id AS internalid,
          item.externalid AS externalid,
          item.itemid AS sku,
          item.displayname AS itemname,
          item.upccode AS upc,
          ib.quantityonhand AS expected_qty,
          ib.binnumber AS bin_id,
          BUILTIN.DF(ib.binnumber) AS bin_number
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        WHERE ib.location = ${selectedLocation.id}
          ${classFilter}
          AND ib.quantityonhand > 0
          AND ib.binnumber IS NOT NULL
        ORDER BY BUILTIN.DF(ib.binnumber), item.itemid
      `, (loaded, total) => setLoadMsg(`Pulling inventory... ${loaded}${total ? ` / ${total}` : ""} items`));
      setExpected(items);
      if (items.length === 0) setError("No inventory found for this class/location.");

      // Check for items with no bin assigned
      setLoadMsg("Checking for unassigned items...");
      const noBinItems = await suiteql(`
        SELECT
          item.id AS internalid,
          item.itemid AS sku,
          item.displayname AS itemname,
          ib.quantityonhand AS qty
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        WHERE ib.location = ${selectedLocation.id}
          ${classFilter}
          AND ib.quantityonhand > 0
          AND ib.binnumber IS NULL
        ORDER BY item.itemid
      `);
      setNoBinItems(noBinItems);

      // Pull ALL bin name→ID mappings via ItemBinQuantity (works for empty bins too)
      setLoadMsg("Loading bins...");
      const binRows = await suiteqlAll(`
        SELECT DISTINCT Bin AS bin_id, BUILTIN.DF(Bin) AS bin_name
        FROM ItemBinQuantity
        WHERE Bin IS NOT NULL
      `, (loaded) => setLoadMsg(`Loading bins... ${loaded}`));
      const bMap = {};
      binRows.forEach(r => { if (r.bin_name && r.bin_id) bMap[r.bin_name] = r.bin_id; });
      setLocationBinMap(bMap);
      console.log("Loaded bin map:", Object.keys(bMap).length, "bins");

      setSelectedPrefixes(null);
      setPhase("styles");
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

  const [extraAlert, setExtraAlert] = useState(null); // {sku, upc, bin} for extra item popup

  const handleItemScan = useCallback((upc) => {
    const trimmed = upc.trim(); if (!trimmed) return;
    const key = currentBin ? `${currentBin}::${trimmed}` : trimmed;
    const match = upcLookup[trimmed];
    setScans(p => ({ ...p, [key]: (p[key] || 0) + 1 }));
    setScanLog(p => [{ upc: trimmed, bin: currentBin, time: new Date(), itemname: match?.itemname || null, sku: match?.sku || null }, ...p]);

    if (!match) {
      // UPC not recognized at all
      beepWarn(); setFlash("warn");
    } else {
      // UPC recognized — check if expected in this bin
      const isExpectedInBin = currentBin && binExpected.some(i => i.upc === trimmed);
      const prefixSet = selectedPrefixes ? new Set(selectedPrefixes.map(p => p.toUpperCase())) : null;
      const isInSelectedPrefixes = !prefixSet || prefixSet.has(getSkuPrefix(match.sku));

      if (isExpectedInBin && isInSelectedPrefixes) {
        // Normal expected item
        beepOk(); setFlash("ok");
      } else {
        // Recognized but EXTRA — not expected in this bin or class
        beepExtra(); setFlash("extra");
        setExtraAlert({ sku: match.sku, upc: trimmed, bin: currentBin });
        setTimeout(() => setExtraAlert(null), 4000);
      }
    }
    setTimeout(() => setFlash(null), 400);
  }, [upcLookup, currentBin, binExpected, selectedPrefixes]);

  // ── LOOKUP HANDLER ──
  const handleLookup = async (upc) => {
    const trimmed = upc.trim(); if (!trimmed) return;
    setLookupLoading(true); setError(null);
    try {
      const rows = await suiteql(`
        SELECT
          item.id AS internalid,
          item.itemid AS sku,
          item.displayname AS itemname,
          item.upccode AS upc,
          ib.quantityonhand AS qty,
          ib.binnumber AS bin_id,
          BUILTIN.DF(ib.binnumber) AS bin_name,
          BUILTIN.DF(ib.location) AS location_name
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        WHERE item.upccode = '${trimmed.replace(/'/g, "''")}'
          AND ib.quantityonhand > 0
        ORDER BY BUILTIN.DF(ib.location), BUILTIN.DF(ib.binnumber)
      `);

      let itemInfo = null;
      if (rows.length > 0) {
        itemInfo = { sku: rows[0].sku, itemname: rows[0].itemname, upc: rows[0].upc };
      } else {
        // Try to find the item even if no inventory
        const itemRows = await suiteql(`
          SELECT id, itemid AS sku, displayname AS itemname, upccode AS upc
          FROM item WHERE upccode = '${trimmed.replace(/'/g, "''")}'
        `);
        if (itemRows.length > 0) itemInfo = itemRows[0];
      }

      const result = { upc: trimmed, item: itemInfo, bins: rows, time: new Date() };
      setLookupResults([result, ...lookupHistory]);
      setLookupHistory(p => [result, ...p].slice(0, 20));
      if (!itemInfo) beepWarn(); else beepOk();
    } catch (e) {
      setError(`Lookup failed: ${e.message}`);
    } finally { setLookupLoading(false); }
  };

  const undoLast = () => {
    if (scanLog.length === 0) return;
    const last = scanLog[0];
    const key = last.bin ? `${last.bin}::${last.upc}` : last.upc;
    setScans(p => { const n = { ...p }; if (n[key] > 1) n[key]--; else delete n[key]; return n; });
    setScanLog(p => p.slice(1));
  };

  const switchBin = () => { setCurrentBin(null); setTimeout(() => binRef.current?.focus(), 100); };

  const restartCount = () => {
    if (!confirm("Clear all scans and start over?")) return;
    setScans({}); setScanLog([]); setBinHistory([]); setCurrentBin(null);
    setFlash(null); setFilter(""); clearSession();
  };

  // Manual SKU entry
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const manualRef = useRef(null);

  const skuLookup = useMemo(() => {
    const m = {};
    expected.forEach(item => { if (item.sku) m[item.sku.toUpperCase()] = item; });
    return m;
  }, [expected]);

  const handleManualAdd = () => {
    const trimmed = manualSku.trim().toUpperCase();
    if (!trimmed) return;
    const match = skuLookup[trimmed];
    if (match && match.upc) {
      handleItemScan(match.upc);
      setManualSku(""); setShowManualAdd(false);
    } else if (match && !match.upc) {
      const key = currentBin ? `${currentBin}::SKU:${match.sku}` : `SKU:${match.sku}`;
      setScans(p => ({ ...p, [key]: (p[key] || 0) + 1 }));
      setScanLog(p => [{ upc: `SKU:${match.sku}`, bin: currentBin, time: new Date(), itemname: match.itemname, sku: match.sku }, ...p]);
      beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
      setManualSku(""); setShowManualAdd(false);
    } else {
      setError(`SKU "${trimmed}" not found in expected inventory.`);
    }
  };

  // ══════════════════════════════════════════════════════════
  // COMPARISON — FIXED: filters by scanned bins AND selected prefixes
  // ══════════════════════════════════════════════════════════
  const getComparison = useCallback(() => {
    const rows = []; const done = new Set();

    // Only compare items from bins we actually scanned
    const scannedBinsUpper = new Set(binHistory.map(b => b.toUpperCase()));

    // Only compare items matching selected style prefixes
    const prefixSet = selectedPrefixes ? new Set(selectedPrefixes.map(p => p.toUpperCase())) : null;

    expected.forEach(item => {
      const upc = item.upc || "";
      const bin = item.bin_number || "";
      const binId = item.bin_id || "";

      // SKIP items from bins we didn't scan
      if (bin && scannedBinsUpper.size > 0 && !scannedBinsUpper.has(bin.toUpperCase())) return;

      // SKIP items not in selected prefixes
      if (prefixSet && !prefixSet.has(getSkuPrefix(item.sku))) return;

      const upcKey = bin ? `${bin}::${upc}` : upc;
      const skuKey = bin ? `${bin}::SKU:${item.sku}` : `SKU:${item.sku}`;
      const sq = (upc ? (scans[upcKey] || 0) : 0) + (scans[skuKey] || 0);
      const eq = Number(item.expected_qty) || 0;
      let status = "matched";
      if (sq === 0) status = "review"; else if (sq !== eq) status = "variance";
      rows.push({ ...item, upc, bin, bin_id: binId, scanned_qty: sq, expected_qty: eq, status, diff: sq - eq });
      if (upc) done.add(upcKey);
      done.add(skuKey);
    });

    // Also include scanned items not in expected
    Object.entries(scans).forEach(([key, count]) => {
      if (!done.has(key)) {
        const [bin, val] = key.includes("::") ? key.split("::") : ["", key];
        const upc = val.startsWith("SKU:") ? "" : val;
        const sku = val.startsWith("SKU:") ? val.replace("SKU:", "") : "";
        const m = upc ? upcLookup[upc] : skuLookup[sku.toUpperCase()];
        rows.push({ internalid: m?.internalid || "", externalid: m?.externalid || "", sku: m?.sku || sku || "", itemname: m?.itemname || `Unknown (${val})`, upc: upc || "", bin, bin_id: "", scanned_qty: count, expected_qty: 0, status: "unexpected", diff: count });
      }
    });
    return rows;
  }, [expected, scans, upcLookup, skuLookup, binHistory, selectedPrefixes]);

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
    const h = "Internal ID,External ID,SKU,Item Name,UPC,Bin,Bin ID,Expected Qty,Scanned Qty,Difference,Status\n";
    const b = rows.map(r => `"${r.internalid}","${r.externalid || ""}","${r.sku}","${(r.itemname || "").replace(/"/g, '""')}","${r.upc}","${r.bin}","${r.bin_id || ""}",${r.expected_qty},${r.scanned_qty},${r.diff},"${ST[r.status].l}"`).join("\n");
    dl(h + b, `count_detail_${(selectedLocation?.name || "").replace(/\s+/g, "_")}_${today()}.csv`);
  };

  const exportNS = () => {
    const rows = getComparison().filter(r => r.diff !== 0);
    if (rows.length === 0) { setError("All counts match. No adjustments needed."); return; }
    const locName = (selectedLocation?.name || "location").replace(/\s+/g, "_");
    const extId = `ADJ_${locName}_${today()}`;
    const d = new Date();
    const dateStr = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const periodStr = d.toLocaleString("en-US", { month: "short" }) + " " + d.getFullYear();
    const h = "External ID,Adjustment Account,Adjustment Location,Subsidiary,Date,Posting Period,Internal ID,Item External ID,SKU,Adjust Qty By,Location,Bin Number,Quantity\n";
    const b = rows.map(r =>
      `"${extId}","60050 Inventory Adjustment","${selectedLocation?.name}","Great Lakes Work Wear","${dateStr}","${periodStr}",${r.internalid || ""},"${r.externalid || ""}","${r.sku}",${r.diff},"${selectedLocation?.name}","${r.bin || ""}",${r.diff}`
    ).join("\n");
    dl(h + b, `ns_import_${locName}_${today()}.csv`);
  };

  // ── SHARE / EMAIL ──
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailType, setEmailType] = useState("detail");

  // ── SUBMIT TO NETSUITE ──
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);

  const buildCSVFile = (type) => {
    const rows = type === "ns" ? getComparison().filter(r => r.diff !== 0) : getComparison();
    if (type === "ns" && rows.length === 0) return null;
    const locName = (selectedLocation?.name || "").replace(/\s+/g, "_");
    let content, filename;
    if (type === "ns") {
      const extId = `ADJ_${locName}_${today()}`;
      const d = new Date();
      const dateStr = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      const periodStr = d.toLocaleString("en-US", { month: "short" }) + " " + d.getFullYear();
      const h = "External ID,Adjustment Account,Adjustment Location,Subsidiary,Date,Posting Period,Internal ID,Item External ID,SKU,Adjust Qty By,Location,Bin Number,Quantity\n";
      const b = rows.map(r =>
        `"${extId}","60050 Inventory Adjustment","${selectedLocation?.name}","Great Lakes Work Wear","${dateStr}","${periodStr}",${r.internalid || ""},"${r.externalid || ""}","${r.sku}",${r.diff},"${selectedLocation?.name}","${r.bin || ""}",${r.diff}`
      ).join("\n");
      content = h + b;
      filename = `ns_import_${locName}_${today()}.csv`;
    } else {
      const h = "Internal ID,External ID,SKU,Item Name,UPC,Bin,Bin ID,Expected Qty,Scanned Qty,Difference,Status\n";
      const b = rows.map(r => `"${r.internalid}","${r.externalid || ""}","${r.sku}","${(r.itemname || "").replace(/"/g, '""')}","${r.upc}","${r.bin}","${r.bin_id || ""}",${r.expected_qty},${r.scanned_qty},${r.diff},"${ST[r.status].l}"`).join("\n");
      content = h + b;
      filename = `count_detail_${locName}_${today()}.csv`;
    }
    return new File([content], filename, { type: "text/csv" });
  };

  const shareCSV = async (type) => {
    const file = buildCSVFile(type);
    if (!file) { setError("All counts match. No adjustments needed."); return; }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: `Inventory Count - ${selectedLocation?.name}`, text: `${classPath.map(c => c.name).join(" > ")} count at ${selectedLocation?.name} (${today()})`, files: [file] });
      } catch (e) { if (e.name !== "AbortError") setError("Share failed: " + e.message); }
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a"); a.href = url; a.download = file.name; a.click();
      URL.revokeObjectURL(url);
    }
  };

  const emailCSV = async (type) => {
    if (!emailTo.trim()) { setError("Enter an email address."); return; }
    const file = buildCSVFile(type);
    if (!file) { setError("All counts match. No adjustments needed."); return; }
    setEmailSending(true);
    try {
      const content = await file.text();
      const resp = await fetch("/api/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: emailTo.trim(), subject: `Inventory Count - ${selectedLocation?.name} - ${today()}`, body: `${classPath.map(c => c.name).join(" > ")} count at ${selectedLocation?.name}\n\nCSV file attached.`, filename: file.name, csv: content }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Send failed");
      setShowEmailModal(false); setError(null);
    } catch (e) { setError("Email failed: " + e.message); }
    finally { setEmailSending(false); }
  };

  const submitToNetSuite = async () => {
    const rows = getComparison().filter(r => r.diff !== 0);
    if (rows.length === 0) { setError("All counts match."); return; }
    setSubmitting(true); setSubmitResult(null); setError(null);
    try {
      const resp = await fetch("/api/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: selectedLocation.id,
          locationName: selectedLocation.name,
          subsidiary: "Great Lakes Work Wear",
          memo: `Count: ${classPath.map(c => c.name).join(" > ")} @ ${selectedLocation.name} (${today()})`,
          items: rows.map(r => ({ internalid: r.internalid, diff: r.diff, bin_id: r.bin_id || null, bin_name: r.bin || null, upc: r.upc || null, sku: r.sku || null })),
          binMap: locationBinMap,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setSubmitResult({ success: true, message: data.message, recordUrl: data.recordUrl, recordId: data.recordId });
        setShowSubmitConfirm(false);
      } else {
        setSubmitResult({ success: false, error: data.error || "Unknown error", details: data.details });
      }
    } catch (e) { setSubmitResult({ success: false, error: e.message }); }
    finally { setSubmitting(false); }
  };

  // ── REVIEW EDITS ──
  const [editingItem, setEditingItem] = useState(null);
  const [editValue, setEditValue] = useState("");

  const getScansKey = (row) => {
    const upc = row.upc || ""; const bin = row.bin || ""; const sku = row.sku || "";
    const upcKey = bin ? `${bin}::${upc}` : upc;
    const skuKey = bin ? `${bin}::SKU:${sku}` : `SKU:${sku}`;
    if (upc && scans[upcKey] !== undefined) return upcKey;
    if (scans[skuKey] !== undefined) return skuKey;
    return upc ? upcKey : skuKey;
  };

  const adjustReviewQty = (row, delta) => {
    const key = getScansKey(row);
    setScans(p => {
      const next = Math.max(0, (p[key] || 0) + delta);
      if (next === 0) { const n = { ...p }; delete n[key]; return n; }
      return { ...p, [key]: next };
    });
  };

  const setReviewQty = (row, newQty) => {
    const key = getScansKey(row);
    const qty = Math.max(0, parseInt(newQty) || 0);
    setScans(p => {
      if (qty === 0) { const n = { ...p }; delete n[key]; return n; }
      return { ...p, [key]: qty };
    });
    setEditingItem(null);
  };

  // ═══════════════════════════════════════════════════════════
  // RENDER: HOME
  // ═══════════════════════════════════════════════════════════
  if (phase === "home") {
    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <div style={S.hdr}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>GLWW Inventory</span></div>
          <span style={{ fontSize: 10, color: "#475569", ...mono }}>v4</span>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, marginTop: 20 }}>
          {/* Inventory Count */}
          <button onClick={() => setPhase("setup")} style={{
            ...S.card, padding: 24, cursor: "pointer", border: "1px solid rgba(59,130,246,0.25)",
            background: "rgba(59,130,246,0.04)", textAlign: "left", transition: "all 0.15s",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "rgba(59,130,246,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>📋</div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>Inventory Count</div>
                <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.4 }}>Scan bins and items to count inventory. Compare against NetSuite and submit adjustments.</div>
              </div>
            </div>
          </button>

          {/* Inventory Lookup */}
          <button onClick={() => setPhase("lookup")} style={{
            ...S.card, padding: 24, cursor: "pointer", border: "1px solid rgba(34,197,94,0.25)",
            background: "rgba(34,197,94,0.04)", textAlign: "left", transition: "all 0.15s",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "rgba(34,197,94,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🔍</div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>Inventory Lookup</div>
                <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.4 }}>Scan a UPC to see which bins and locations hold that item and current quantities.</div>
              </div>
            </div>
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: LOOKUP
  // ═══════════════════════════════════════════════════════════
  if (phase === "lookup") {
    const latestResult = lookupResults[0] || null;

    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <div style={S.hdr}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Inventory Lookup</span>
          </div>
          <button style={S.btnSm} onClick={() => { setLookupResults([]); setError(null); setPhase("home"); }}>← Home</button>
        </div>
        <div style={{ padding: 16 }} onClick={() => lookupRef.current?.focus()}>
          {/* Scan input */}
          <div style={{ ...S.card, textAlign: "center", padding: 20, border: "2px solid rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.04)" }}>
            <div style={{ fontSize: 12, color: "#22c55e", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>Scan UPC Barcode</div>
            <input
              ref={lookupRef}
              style={{ ...S.inp, fontSize: 20, textAlign: "center", ...mono }}
              placeholder="Scan or type UPC..."
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") { handleLookup(e.target.value); e.target.value = ""; } }}
            />
            {lookupLoading && <div style={{ marginTop: 8, fontSize: 12, color: "#93c5fd" }}>Looking up...</div>}
          </div>

          {error && <div style={S.err}>{error}</div>}

          {/* Latest result */}
          {latestResult && (
            <div style={{ marginTop: 10 }}>
              {latestResult.item ? (
                <div style={S.card}>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{latestResult.item.sku}</div>
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>{latestResult.item.itemname}</div>
                    <div style={{ fontSize: 11, color: "#64748b", ...mono }}>UPC: {latestResult.upc}</div>
                  </div>

                  {latestResult.bins.length > 0 ? (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                        Found in {latestResult.bins.length} bin{latestResult.bins.length !== 1 ? "s" : ""}
                      </div>
                      <div style={{ borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
                        {latestResult.bins.map((row, i) => (
                          <div key={i} style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
                            background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent",
                          }}>
                            <div>
                              <div style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#a5b4fc" }}>{row.bin_name}</div>
                              <div style={{ fontSize: 11, color: "#64748b" }}>{row.location_name}</div>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 22, fontWeight: 700, ...mono, color: "#22c55e" }}>{row.qty}</div>
                              <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" }}>on hand</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, color: "#94a3b8", textAlign: "right", ...mono }}>
                        Total: <span style={{ fontWeight: 700, color: "#e2e8f0" }}>{latestResult.bins.reduce((a, b) => a + Number(b.qty), 0)}</span>
                      </div>
                    </>
                  ) : (
                    <div style={{ padding: 16, textAlign: "center", color: "#f59e0b", fontSize: 13, background: "rgba(245,158,11,0.06)", borderRadius: 8, border: "1px solid rgba(245,158,11,0.2)" }}>
                      Item exists in NetSuite but has no inventory on hand.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ ...S.card, textAlign: "center", padding: 20, background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.2)" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#ef4444", marginBottom: 4 }}>UPC Not Found</div>
                  <div style={{ fontSize: 13, color: "#94a3b8", ...mono }}>{latestResult.upc}</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>This UPC is not in NetSuite.</div>
                </div>
              )}
            </div>
          )}

          {/* Previous lookups */}
          {lookupHistory.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Previous Lookups</div>
              {lookupHistory.slice(1).map((r, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
                  opacity: 0.7, cursor: "pointer",
                }} onClick={() => setLookupResults([r])}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, ...mono }}>{r.item?.sku || "Unknown"}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{r.upc}</div>
                  </div>
                  <div style={{ fontSize: 12, color: r.item ? "#22c55e" : "#ef4444", ...mono }}>
                    {r.item ? `${r.bins.length} bin${r.bins.length !== 1 ? "s" : ""}` : "Not found"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: SETUP
  // ═══════════════════════════════════════════════════════════
  if (phase === "setup") {
    const hasData = classes.length > 0 || locations.length > 0;
    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <div style={S.hdr}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Inventory Count</span></div>
          <button style={S.btnSm} onClick={() => { clearSession(); setPhase("home"); }}>← Home</button>
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
                {/* All Classes option */}
                <button onClick={() => { setSelectedClassId("ALL"); setClassPath([{ id: "ALL", name: "All Classes" }]); }}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "14px 16px", border: "none", borderBottom: "1px solid rgba(255,255,255,0.08)", background: selectedClassId === "ALL" ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.02)", color: selectedClassId === "ALL" ? "#22c55e" : "#86efac", fontSize: 14, fontWeight: 600, fontFamily: "inherit", textAlign: "left", cursor: "pointer", minHeight: 48 }}>
                  <span>All Classes</span>
                </button>
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
              {selectedClassId && <div style={{ marginTop: 8, fontSize: 12, color: selectedClassId === "ALL" ? "#22c55e" : "#60a5fa", ...mono }}>✓ {classPath.map(c => c.name).join(" > ")}</div>}
            </div>
          )}
          {locations.length > 0 && (
            <div style={S.card}>
              <label style={S.lbl}>Location</label>
              <div style={{ maxHeight: 180, overflowY: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
                {locations.map(loc => {
                  const isSel = selectedLocation?.id === loc.id;
                  return (
                    <button key={loc.id} onClick={() => setSelectedLocation(loc)} style={{ display: "block", width: "100%", padding: "14px 16px", border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)", background: isSel ? "rgba(59,130,246,0.08)" : "transparent", color: isSel ? "#60a5fa" : "#e2e8f0", fontSize: 14, fontFamily: "inherit", textAlign: "left", cursor: "pointer", minHeight: 48 }}>
                      {isSel && "✓ "}{loc.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {classes.length > 0 && (
            <div style={S.card}>
              <label style={S.lbl}>Adjustment Account (optional)</label>
              <input style={S.inp} value={adjustAcct} onChange={e => setAdjustAcct(e.target.value)} placeholder="Can set during NS import instead" />
            </div>
          )}
          {classes.length > 0 && (
            <div style={S.card}>
              <label style={S.lbl}>Email Results To (optional)</label>
              <select style={{ ...S.inp, appearance: "auto" }} value={emailTo} onChange={e => setEmailTo(e.target.value)}>
                <option value="">None</option>
                <option value="rebecca@greatlakesworkwear.com">rebecca@greatlakesworkwear.com</option>
                <option value="bryce@greatlakesworkwear.com">bryce@greatlakesworkwear.com</option>
              </select>
            </div>
          )}
          {error && hasData && <div style={S.err}>{error}</div>}
          {loading && hasData && <div style={S.load}>{loadMsg}</div>}
          {classes.length > 0 && (<>
            <button style={{ ...S.btn, opacity: selectedClassId && selectedLocation ? 1 : 0.4, background: "#22c55e", marginBottom: 10 }} onClick={pullInventory} disabled={!selectedClassId || !selectedLocation || loading}>
              {loading ? "Loading..." : "Pull Inventory & Start Scanning"}
            </button>
            <button style={S.btnSec} onClick={() => { setExpected([]); setPhase("scanning"); }}>Skip — Scan Only</button>
          </>)}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: STYLES
  // ═══════════════════════════════════════════════════════════
  if (phase === "styles") {
    const prefixCounts = {};
    expected.forEach(item => {
      const p = getSkuPrefix(item.sku);
      if (p) prefixCounts[p] = (prefixCounts[p] || 0) + 1;
    });
    const allPrefixes = Object.keys(prefixCounts).sort();
    const filteredPrefixes = styleSearch ? allPrefixes.filter(p => p.toLowerCase().includes(styleSearch.toLowerCase())) : allPrefixes;
    const activePrefixes = selectedPrefixes === null ? new Set(allPrefixes) : new Set(selectedPrefixes);

    const togglePrefix = (p) => {
      const next = new Set(activePrefixes);
      if (next.has(p)) next.delete(p); else next.add(p);
      if (next.size >= allPrefixes.length) setSelectedPrefixes(null);
      else setSelectedPrefixes([...next]);
    };

    const selectedItemCount = expected.filter(item => activePrefixes.has(getSkuPrefix(item.sku))).length;

    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <div style={S.hdr}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Select Styles</span>
          </div>
          <button style={S.btnSm} onClick={() => setPhase("setup")}>← Setup</button>
        </div>
        <div style={{ padding: 16 }}>
          <input style={{ ...S.inp, marginBottom: 10 }} placeholder="Search styles..." value={styleSearch} onChange={e => setStyleSearch(e.target.value)} />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={() => setSelectedPrefixes(null)}>Select All</button>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={() => setSelectedPrefixes([])}>Deselect All</button>
          </div>
          <div style={{ ...S.card, maxHeight: 400, overflowY: "auto" }}>
            {filteredPrefixes.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: "#475569", fontSize: 13 }}>{expected.length === 0 ? "No inventory loaded." : "No styles match."}</div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {filteredPrefixes.map(p => {
                const isSel = activePrefixes.has(p);
                return (
                  <button key={p} onClick={() => togglePrefix(p)} style={{
                    padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", touchAction: "manipulation",
                    border: isSel ? "1px solid rgba(59,130,246,0.5)" : "1px solid rgba(255,255,255,0.1)",
                    background: isSel ? "rgba(59,130,246,0.15)" : "rgba(255,255,255,0.05)",
                    color: isSel ? "#60a5fa" : "#94a3b8", transition: "all 0.15s",
                  }}>
                    <span style={mono}>{p}</span>
                    <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>({prefixCounts[p]})</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 13, color: "#94a3b8", textAlign: "center", ...mono }}>
            <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{selectedItemCount}</span> items in <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{activePrefixes.size}</span> styles
          </div>

          {/* No-bin items warning */}
          {noBinItems.length > 0 && (
            <div style={{ marginTop: 12, borderRadius: 8, border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.06)", overflow: "hidden" }}>
              <button onClick={() => setShowNoBin(p => !p)} style={{
                width: "100%", padding: "12px 14px", border: "none", background: "transparent",
                color: "#f59e0b", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <span>⚠ {noBinItems.length} item{noBinItems.length !== 1 ? "s" : ""} at this location with no bin assigned</span>
                <span style={{ fontSize: 16 }}>{showNoBin ? "▲" : "▼"}</span>
              </button>
              {showNoBin && (
                <div style={{ maxHeight: 300, overflowY: "auto", borderTop: "1px solid rgba(245,158,11,0.15)" }}>
                  {noBinItems.map((item, i) => (
                    <div key={i} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.03)",
                      background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent",
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{item.sku}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>{item.itemname}</div>
                      </div>
                      <div style={{ ...mono, fontSize: 14, fontWeight: 700, color: "#f59e0b" }}>{item.qty}</div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ padding: "8px 14px", fontSize: 11, color: "#94a3b8", borderTop: "1px solid rgba(245,158,11,0.1)" }}>
                These items are excluded from counting. Assign them to bins in NetSuite to include them.
              </div>
            </div>
          )}

          <button style={{ ...S.btn, background: "#22c55e", marginTop: 14, opacity: activePrefixes.size > 0 ? 1 : 0.4 }} onClick={() => setPhase("scanning")} disabled={activePrefixes.size === 0}>
            Start Scanning
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: SCANNING
  // ═══════════════════════════════════════════════════════════
  if (phase === "scanning") {
    const fb = flash === "ok" ? "rgba(34,197,94,0.5)" : flash === "warn" ? "rgba(245,158,11,0.5)" : flash === "extra" ? "rgba(167,139,250,0.6)" : flash === "bin" ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.06)";
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
          {!currentBin ? (
            <div style={{ ...S.card, background: "rgba(99,102,241,0.04)", border: "2px solid rgba(99,102,241,0.3)", textAlign: "center", padding: 20 }}>
              <div style={{ fontSize: 12, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>Scan Bin Barcode</div>
              <input ref={binRef} style={{ ...S.inp, fontSize: 20, textAlign: "center", ...mono }} placeholder="Scan bin..." autoFocus onKeyDown={e => { if (e.key === "Enter") { handleBinScan(e.target.value); e.target.value = ""; } }} />
              {binHistory.length > 0 && <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>Done: {binHistory.join(", ")}</div>}
            </div>
          ) : (<>
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
            <div style={{ ...S.card, border: `2px solid ${fb}`, transition: "all 0.2s", background: flash === "ok" ? "rgba(34,197,94,0.04)" : flash === "warn" ? "rgba(245,158,11,0.04)" : flash === "extra" ? "rgba(167,139,250,0.06)" : "transparent", textAlign: "center", padding: 16 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700, marginBottom: 8, transition: "color 0.2s", color: flash === "ok" ? "#22c55e" : flash === "warn" ? "#f59e0b" : flash === "extra" ? "#a78bfa" : "#94a3b8" }}>
                {flash === "ok" ? "✓ Recognized" : flash === "warn" ? "⚠ Unknown UPC" : flash === "extra" ? "⚠ EXTRA — Not Expected" : "Scan Items"}
              </div>
              <input ref={scanRef} style={{ ...S.inp, fontSize: 20, textAlign: "center", ...mono }} placeholder="Scan item..." autoFocus onKeyDown={e => { if (e.key === "Enter") { handleItemScan(e.target.value); e.target.value = ""; } }} />
              {scanLog.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: "#64748b" }}>Last: <span style={mono}>{scanLog[0]?.upc}</span>{scanLog[0]?.sku && <span> — {scanLog[0].sku}</span>}</div>}
              <button style={{ ...S.btnSm, marginTop: 8, fontSize: 11 }} onClick={undoLast} disabled={scanLog.length === 0}>Undo Last</button>
            </div>
            {/* EXTRA item alert */}
            {extraAlert && (
              <div style={{
                ...S.card, padding: "12px 16px", marginBottom: 8,
                background: "rgba(167,139,250,0.1)", border: "2px solid rgba(167,139,250,0.5)",
                textAlign: "center", animation: "none",
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#a78bfa", marginBottom: 4 }}>⚠ EXTRA ITEM</div>
                <div style={{ fontSize: 13, color: "#e2e8f0" }}>
                  <span style={{ ...mono, fontWeight: 600 }}>{extraAlert.sku}</span> is not expected in bin <span style={{ ...mono, color: "#818cf8" }}>{extraAlert.bin}</span>
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Item was added to count. Review before submitting.</div>
              </div>
            )}
            {binExpected.length > 0 && (
              <div style={{ ...S.card, padding: 0 }}>
                <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5 }}>Expected in {currentBin} ({binExpected.length} items)</div>
                <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  {binExpected.map((item, i) => {
                    const sq = binScans[item.upc] || binScans[`SKU:${item.sku}`] || 0;
                    const eq = Number(item.expected_qty) || 0;
                    const done = sq >= eq;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.03)", background: done ? "rgba(34,197,94,0.04)" : "transparent", opacity: done ? 0.6 : 1 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, ...mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: done ? "line-through" : "none", color: done ? "#22c55e" : "#e2e8f0" }}>{item.sku}</div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{item.upc || "No UPC"}</div>
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
          {showManualAdd && currentBin && (
            <div style={{ ...S.card, background: "rgba(245,158,11,0.04)", border: "1px solid rgba(245,158,11,0.25)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#f59e0b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Manual Add by SKU</div>
              <input ref={manualRef} style={{ ...S.inp, fontSize: 16, ...mono }} placeholder="Type SKU and press Enter..." value={manualSku} onChange={e => setManualSku(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleManualAdd(); }} onClick={e => e.stopPropagation()} autoFocus />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button style={{ ...S.btnSm, flex: 1, background: "rgba(245,158,11,0.15)", color: "#f59e0b", borderColor: "rgba(245,158,11,0.3)" }} onClick={handleManualAdd}>Add</button>
                <button style={{ ...S.btnSm, flex: 1 }} onClick={() => { setShowManualAdd(false); setManualSku(""); scanRef.current?.focus(); }}>Cancel</button>
              </div>
            </div>
          )}
          {error && <div style={S.err}>{error}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button style={{ ...S.btnSec, padding: "10px 14px", flex: 1 }} onClick={() => { clearSession(); setPhase("setup"); }}>← Setup</button>
            {currentBin && !showManualAdd && (
              <button style={{ ...S.btnSec, padding: "10px 14px", flex: 1, color: "#f59e0b", borderColor: "rgba(245,158,11,0.3)" }} onClick={(e) => { e.stopPropagation(); setShowManualAdd(true); }}>No Barcode?</button>
            )}
            <button style={{ ...S.btnSec, padding: "10px 14px", flex: 1, color: "#ef4444", borderColor: "rgba(239,68,68,0.3)" }} onClick={(e) => { e.stopPropagation(); restartCount(); }}>Restart</button>
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
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4, ...mono }}>{classPath.map(c => c.name).join(" > ")} • {selectedLocation?.name}</div>
        <div style={{ fontSize: 11, color: "#475569", marginBottom: 8 }}>Bins counted: <span style={{ ...mono, color: "#818cf8" }}>{binHistory.join(", ") || "None"}</span></div>
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
          <strong>{adjCount}</strong> item{adjCount !== 1 ? "s" : ""} need adjustment.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
          <button style={S.btnSec} onClick={exportDetail}>Download Detail</button>
          <button style={{ ...S.btn, padding: "12px 16px" }} onClick={exportNS}>Download NS CSV</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <button style={{ ...S.btnSec, background: "rgba(99,102,241,0.1)", borderColor: "rgba(99,102,241,0.3)", color: "#a5b4fc" }} onClick={() => shareCSV("detail")}>Share Detail</button>
          <button style={{ ...S.btnSec, background: "rgba(99,102,241,0.1)", borderColor: "rgba(99,102,241,0.3)", color: "#a5b4fc" }} onClick={() => shareCSV("ns")}>Share NS CSV</button>
        </div>
        {emailTo && (
          <button style={{ ...S.btnSec, marginBottom: 10, background: "rgba(34,197,94,0.08)", borderColor: "rgba(34,197,94,0.25)", color: "#86efac", textAlign: "center" }} onClick={() => { setEmailType("detail"); setShowEmailModal(true); }}>Email to {emailTo}</button>
        )}
        {!submitResult?.success && (
          <button style={{ ...S.btn, marginBottom: 10, background: "#7c3aed", fontSize: 15 }} onClick={() => setShowSubmitConfirm(true)} disabled={submitting || adjCount === 0}>
            {submitting ? "Submitting..." : `Submit to NetSuite (${adjCount} items)`}
          </button>
        )}
        {submitResult && (
          <div style={{ padding: "14px 16px", borderRadius: 8, marginBottom: 10, background: submitResult.success ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)", border: `1px solid ${submitResult.success ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: submitResult.success ? "#22c55e" : "#ef4444", marginBottom: 6 }}>{submitResult.success ? "✓ Adjustment Created" : "✗ Submission Failed"}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: submitResult.recordUrl ? 8 : 0 }}>{submitResult.success ? submitResult.message : (submitResult.error || "Unknown error")}</div>
            {submitResult.details && !submitResult.success && <div style={{ fontSize: 11, color: "#f87171", marginTop: 4, ...mono, wordBreak: "break-all" }}>{typeof submitResult.details === "string" ? submitResult.details : JSON.stringify(submitResult.details).slice(0, 300)}</div>}
            {submitResult.recordUrl && <a href={submitResult.recordUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", padding: "10px 16px", borderRadius: 6, background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", color: "#60a5fa", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>Open in NetSuite →</a>}
          </div>
        )}
        {showSubmitConfirm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => setShowSubmitConfirm(false)}>
            <div style={{ ...S.card, maxWidth: 380, width: "100%", background: "#1e293b" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#e2e8f0" }}>Submit to NetSuite?</div>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16, lineHeight: 1.5 }}>This will create an inventory adjustment with <strong style={{ color: "#e2e8f0" }}>{adjCount} line items</strong> at <strong style={{ color: "#e2e8f0" }}>{selectedLocation?.name}</strong>.</div>
              <div style={{ ...S.card, padding: "10px 14px", marginBottom: 16, background: "rgba(255,255,255,0.03)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}><span style={{ color: "#64748b" }}>Location</span><span style={mono}>{selectedLocation?.name}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}><span style={{ color: "#64748b" }}>Increases</span><span style={{ ...mono, color: "#22c55e" }}>{comparison.filter(r => r.diff > 0).length}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "#64748b" }}>Decreases</span><span style={{ ...mono, color: "#ef4444" }}>{comparison.filter(r => r.diff < 0).length}</span></div>
              </div>
              <button style={{ ...S.btn, background: "#7c3aed", marginBottom: 8 }} onClick={submitToNetSuite} disabled={submitting}>{submitting ? "Creating Adjustment..." : "Confirm & Submit"}</button>
              <button style={S.btnSec} onClick={() => setShowSubmitConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}
        {showEmailModal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={() => setShowEmailModal(false)}>
            <div style={{ ...S.card, maxWidth: 360, width: "100%", background: "#1e293b" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Email CSV</div>
              <label style={S.lbl}>To</label>
              <select style={{ ...S.inp, marginBottom: 12, appearance: "auto" }} value={emailTo} onChange={e => setEmailTo(e.target.value)}>
                <option value="rebecca@greatlakesworkwear.com">rebecca@greatlakesworkwear.com</option>
                <option value="bryce@greatlakesworkwear.com">bryce@greatlakesworkwear.com</option>
              </select>
              <label style={S.lbl}>Which CSV?</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button onClick={() => setEmailType("detail")} style={{ ...S.btnSm, flex: 1, background: emailType === "detail" ? "rgba(59,130,246,0.15)" : undefined, color: emailType === "detail" ? "#60a5fa" : "#94a3b8" }}>Count Detail</button>
                <button onClick={() => setEmailType("ns")} style={{ ...S.btnSm, flex: 1, background: emailType === "ns" ? "rgba(59,130,246,0.15)" : undefined, color: emailType === "ns" ? "#60a5fa" : "#94a3b8" }}>NS Import</button>
              </div>
              <button style={{ ...S.btn, background: "#22c55e" }} onClick={() => emailCSV(emailType)} disabled={emailSending}>{emailSending ? "Sending..." : "Send Email"}</button>
              <button style={{ ...S.btnSec, marginTop: 8 }} onClick={() => setShowEmailModal(false)}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 380px)" }}>
            {filtered.map((r, i) => {
              const isEditing = editingItem === `${r.internalid}-${r.bin}`;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.03)", background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                      <Badge s={r.status} />
                      {r.bin && <span style={{ fontSize: 10, color: "#818cf8", ...mono }}>{r.bin}</span>}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, ...mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku || r.itemname}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{r.upc || "No UPC"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                    <button onClick={(e) => { e.stopPropagation(); adjustReviewQty(r, -1); }} style={{ width: 32, height: 32, borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 18, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit", touchAction: "manipulation" }}>−</button>
                    {isEditing ? (
                      <input autoFocus style={{ ...S.inp, width: 50, padding: "4px 6px", fontSize: 16, textAlign: "center", ...mono, minHeight: 32 }} value={editValue} onChange={e => setEditValue(e.target.value.replace(/[^0-9]/g, ""))} onKeyDown={e => { if (e.key === "Enter") setReviewQty(r, editValue); if (e.key === "Escape") setEditingItem(null); }} onBlur={() => setReviewQty(r, editValue)} onClick={e => e.stopPropagation()} />
                    ) : (
                      <div onClick={(e) => { e.stopPropagation(); setEditingItem(`${r.internalid}-${r.bin}`); setEditValue(String(r.scanned_qty)); }} style={{ ...mono, fontSize: 16, fontWeight: 700, textAlign: "center", minWidth: 40, padding: "4px 6px", borderRadius: 6, cursor: "pointer", border: "1px dashed rgba(255,255,255,0.15)", color: "#e2e8f0" }}>{r.scanned_qty}</div>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); adjustReviewQty(r, 1); }} style={{ width: 32, height: 32, borderRadius: 6, border: "1px solid rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.1)", color: "#22c55e", fontSize: 18, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit", touchAction: "manipulation" }}>+</button>
                    <div style={{ textAlign: "right", marginLeft: 4, minWidth: 44 }}>
                      <div style={{ fontSize: 10, color: "#64748b" }}>/ {r.expected_qty}</div>
                      <div style={{ ...mono, fontSize: 13, fontWeight: 700, color: r.diff === 0 ? "#22c55e" : r.diff > 0 ? "#f59e0b" : "#ef4444" }}>{r.diff > 0 ? `+${r.diff}` : r.diff}</div>
                    </div>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#475569" }}>No items match filter.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
