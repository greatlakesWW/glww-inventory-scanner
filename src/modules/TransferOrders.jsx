import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  suiteql, suiteqlBatched, nsRecord, beepOk, beepWarn, beepBin,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo,
  loadSession, saveSession, clearSession, ScanInput,
  useScanRefocus, PulsingDot, ResumePrompt,
} from "../shared";
import { useItemDetailDrawer } from "../components/ItemDetail";
import { logActivity } from "../activityLog";

const SESSION_KEY = "glww_transfer_orders";
const SALES_FLOOR_BIN = "F-01-0001";

// ═══════════════════════════════════════════════════════════
// PICK PLAN ALGORITHM
// ═══════════════════════════════════════════════════════════
function buildPickPlan(lines, binData) {
  // binData: [{item_id, bin_number, bin_id, qty_in_bin}]
  // Build map: item_id -> [{bin_number, bin_id, qty_in_bin}] sorted by bin asc
  const binsByItem = {};
  binData.forEach(b => {
    if (!binsByItem[b.item_id]) binsByItem[b.item_id] = [];
    binsByItem[b.item_id].push({ ...b, remaining: Number(b.qty_in_bin) });
  });

  // For each line, allocate picks from lowest bin first
  const picksByBin = {}; // bin_number -> [{item_id, item_name, sku, upc, qty, line_id}]
  const unpicked = [];

  for (const line of lines) {
    let need = Number(line.remaining_qty);
    const bins = binsByItem[line.item_id] || [];
    for (const bin of bins) {
      if (need <= 0) break;
      const take = Math.min(need, bin.remaining);
      if (take <= 0) continue;
      bin.remaining -= take;
      if (!picksByBin[bin.bin_number]) picksByBin[bin.bin_number] = { bin_number: bin.bin_number, bin_id: bin.bin_id, items: [] };
      picksByBin[bin.bin_number].items.push({
        item_id: line.item_id, item_name: line.item_name, sku: line.sku, upc: line.upc,
        qty: take, line_id: line.line_id,
      });
      need -= take;
    }
    if (need > 0) unpicked.push({ ...line, short_qty: need });
  }

  // Sort stops by bin number
  const stops = Object.values(picksByBin).sort((a, b) => a.bin_number.localeCompare(b.bin_number));
  return { stops, unpicked };
}

// ═══════════════════════════════════════════════════════════
// STATUS BADGE
// ═══════════════════════════════════════════════════════════
const STATUS_COLORS = {
  "Pending Fulfillment": { c: "#f59e0b", bg: "rgba(245,158,11,0.08)", bc: "rgba(245,158,11,0.3)" },
  "Pending Receipt": { c: "#3b82f6", bg: "rgba(59,130,246,0.08)", bc: "rgba(59,130,246,0.3)" },
};
const TOBadge = ({ status }) => {
  const s = STATUS_COLORS[status] || { c: "#94a3b8", bg: "rgba(148,163,184,0.08)", bc: "rgba(148,163,184,0.3)" };
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: 0.4, textTransform: "uppercase", color: s.c, background: s.bg, border: `1px solid ${s.bc}` }}>
      {status}
    </span>
  );
};

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export default function TransferOrders({ onBack }) {
  const saved = useRef(loadSession(SESSION_KEY)).current;
  const hasSavedSession = saved && saved.phase && saved.phase !== "setup";

  const [showResume, setShowResume] = useState(hasSavedSession);
  // Core state
  const [phase, setPhase] = useState(hasSavedSession ? "setup" : (saved?.phase || "setup"));
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState(null);

  // Phase 1
  const [locations, setLocations] = useState(saved?.locations || []);
  const [selectedLocationId, setSelectedLocationId] = useState(saved?.selectedLocationId || "");
  const [selectedLocationName, setSelectedLocationName] = useState(saved?.selectedLocationName || "");
  const [mode, setMode] = useState(saved?.mode || ""); // "outbound" | "inbound"
  const [transferOrders, setTransferOrders] = useState(saved?.transferOrders || []);
  const [selectedTO, setSelectedTO] = useState(saved?.selectedTO || null);

  // Phase 2 Outbound
  const [toLines, setToLines] = useState(saved?.toLines || []);
  const [pickPlan, setPickPlan] = useState(saved?.pickPlan || null);
  const [currentStop, setCurrentStop] = useState(saved?.currentStop || 0);
  const [binConfirmed, setBinConfirmed] = useState(saved?.binConfirmed || false);
  const [pickedItems, setPickedItems] = useState(saved?.pickedItems || {}); // "stop::item_id" -> count
  const [flash, setFlash] = useState(null);
  const scanRef = useRef(null);
  const { openDrawer, DrawerComponent } = useItemDetailDrawer(scanRef);

  // Phase 2B Inbound
  const [receivedItems, setReceivedItems] = useState(saved?.receivedItems || {}); // "item_id" -> count
  const [binAssignments, setBinAssignments] = useState(saved?.binAssignments || {}); // "item_id" -> bin_number
  const [suggestedBins, setSuggestedBins] = useState(saved?.suggestedBins || {}); // "item_id" -> {bin_number, bin_id}
  const [inboundBinConfirmed, setInboundBinConfirmed] = useState(saved?.inboundBinConfirmed || {});

  // Phase 4
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(saved?.submitResult || null);

  // Click-anywhere re-focus
  useScanRefocus(scanRef, phase === "outbound" || phase === "inbound");

  // Session resume
  const handleResume = () => {
    setShowResume(false);
    setPhase(saved?.phase || "setup");
  };
  const handleFresh = () => {
    setShowResume(false);
    clearSession(SESSION_KEY);
    setPhase("setup"); setMode(""); setSelectedLocationId(""); setSelectedLocationName("");
    setTransferOrders([]); setSelectedTO(null); setToLines([]); setPickPlan(null);
    setCurrentStop(0); setBinConfirmed(false); setPickedItems({});
    setReceivedItems({}); setBinAssignments({}); setSuggestedBins({});
    setInboundBinConfirmed({}); setSubmitResult(null); setError(null);
  };

  // ── SESSION SAVE ──
  useEffect(() => {
    if (phase === "done") return;
    saveSession(SESSION_KEY, {
      phase, locations, selectedLocationId, selectedLocationName, mode, transferOrders, selectedTO,
      toLines, pickPlan, currentStop, binConfirmed, pickedItems,
      receivedItems, binAssignments, suggestedBins, inboundBinConfirmed, submitResult,
    });
  }, [phase, locations, selectedLocationId, selectedLocationName, mode, transferOrders, selectedTO,
    toLines, pickPlan, currentStop, binConfirmed, pickedItems,
    receivedItems, binAssignments, suggestedBins, inboundBinConfirmed, submitResult]);

  // ── LOCATION LOADING ──
  const loadLocations = async () => {
    try {
      const rows = await suiteql(`SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name`);
      setLocations(rows);
    } catch (e) { setError(`Failed to load locations: ${e.message}`); }
  };
  useEffect(() => { if (locations.length === 0) loadLocations(); }, []);

  // ── LOAD TRANSFER ORDERS ──
  const loadTOs = async (locId, m) => {
    setLoading(true); setError(null); setLoadMsg("Loading transfer orders...");
    try {
      const locFilter = m === "outbound" ? `t.location = ${locId}` : `t.transferlocation = ${locId}`;
      const statuses = m === "outbound" ? `'TrnfrOrd:B', 'TrnfrOrd:D'` : `'TrnfrOrd:E', 'TrnfrOrd:F'`;
      const rows = await suiteql(`
        SELECT t.id AS internalid, t.tranid AS to_number, t.trandate AS order_date,
          BUILTIN.DF(t.location) AS from_location, BUILTIN.DF(t.transferlocation) AS to_location,
          BUILTIN.DF(t.status) AS status
        FROM transaction t
        WHERE t.type = 'TrnfrOrd' AND ${locFilter} AND t.status IN (${statuses})
        ORDER BY t.trandate DESC
      `);
      setTransferOrders(rows);
      if (rows.length === 0) setError("No transfer orders found.");
    } catch (e) { setError(`Failed: ${e.message}`); }
    finally { setLoading(false); setLoadMsg(""); }
  };

  const handleLocationChange = (locId) => {
    const loc = locations.find(l => String(l.id) === String(locId));
    setSelectedLocationId(locId);
    setSelectedLocationName(loc?.name || "");
    setTransferOrders([]);
    setSelectedTO(null);
    if (locId && mode) loadTOs(locId, mode);
  };

  const handleModeChange = (m) => {
    setMode(m);
    setTransferOrders([]);
    setSelectedTO(null);
    if (selectedLocationId && m) loadTOs(selectedLocationId, m);
  };

  // ── LOAD TO LINES (outbound) ──
  const loadOutboundData = async (to) => {
    setLoading(true); setError(null); setLoadMsg("Loading line items...");
    try {
      const lines = await suiteql(`
        SELECT tl.id AS line_id, tl.linesequencenumber AS line_number, tl.item AS item_id,
          BUILTIN.DF(tl.item) AS item_name, tl.quantity AS ordered_qty, tl.quantityfulfilled AS fulfilled_qty,
          (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) AS remaining_qty,
          item.itemid AS sku, item.upccode AS upc
        FROM transactionline tl JOIN item ON tl.item = item.id
        WHERE tl.transaction = ${to.internalid} AND tl.mainline = 'F'
          AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
          AND (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) > 0
        ORDER BY item.itemid
      `);
      setToLines(lines);

      if (lines.length === 0) { setError("No items to fulfill."); setLoading(false); return; }

      setLoadMsg("Loading bin locations...");
      const bins = await suiteqlBatched(`
        SELECT ib.item AS item_id, BUILTIN.DF(ib.binnumber) AS bin_number, ib.binnumber AS bin_id,
          ib.quantityonhand AS qty_in_bin
        FROM inventorybalance ib
        WHERE ib.item IN ({IDS}) AND ib.location = ${selectedLocationId} AND ib.quantityonhand > 0
        ORDER BY BUILTIN.DF(ib.binnumber) ASC
      `, lines.map(l => l.item_id));

      const plan = buildPickPlan(lines, bins);
      setPickPlan(plan);
      setCurrentStop(0);
      setBinConfirmed(false);
      setPickedItems({});
      setPhase("outbound");
    } catch (e) { setError(`Failed: ${e.message}`); }
    finally { setLoading(false); setLoadMsg(""); }
  };

  // ── LOAD TO LINES (inbound) ──
  const loadInboundData = async (to) => {
    setLoading(true); setError(null); setLoadMsg("Loading line items...");
    try {
      const lines = await suiteql(`
        SELECT tl.id AS line_id, tl.linesequencenumber AS line_number, tl.item AS item_id,
          BUILTIN.DF(tl.item) AS item_name, tl.quantity AS ordered_qty, tl.quantityfulfilled AS fulfilled_qty,
          tl.quantityreceived AS received_qty,
          (tl.quantityfulfilled - COALESCE(tl.quantityreceived, 0)) AS remaining_qty,
          item.itemid AS sku, item.upccode AS upc
        FROM transactionline tl JOIN item ON tl.item = item.id
        WHERE tl.transaction = ${to.internalid} AND tl.mainline = 'F'
          AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
          AND (tl.quantityfulfilled - COALESCE(tl.quantityreceived, 0)) > 0
        ORDER BY item.itemid
      `);
      setToLines(lines);

      if (lines.length === 0) { setError("No items to receive."); setLoading(false); return; }

      const isSalesFloor = selectedLocationName.toLowerCase().includes("sales floor");
      const initBins = {};
      const initConfirmed = {};

      if (isSalesFloor) {
        lines.forEach(l => { initBins[l.item_id] = SALES_FLOOR_BIN; initConfirmed[l.item_id] = true; });
      } else {
        setLoadMsg("Loading suggested bins...");
        const bins = await suiteqlBatched(`
          SELECT ib.item AS item_id, BUILTIN.DF(ib.binnumber) AS bin_number, ib.binnumber AS bin_id
          FROM inventorybalance ib
          WHERE ib.item IN ({IDS}) AND ib.location = ${selectedLocationId} AND ib.quantityonhand > 0
          ORDER BY BUILTIN.DF(ib.binnumber) ASC
        `, lines.map(l => l.item_id));
        const suggested = {};
        bins.forEach(b => { if (!suggested[b.item_id]) suggested[b.item_id] = { bin_number: b.bin_number, bin_id: b.bin_id }; });
        setSuggestedBins(suggested);
        lines.forEach(l => { if (suggested[l.item_id]) initBins[l.item_id] = suggested[l.item_id].bin_number; });
      }

      setBinAssignments(initBins);
      setInboundBinConfirmed(initConfirmed);
      setReceivedItems({});
      setPhase("inbound");
    } catch (e) { setError(`Failed: ${e.message}`); }
    finally { setLoading(false); setLoadMsg(""); }
  };

  const selectTO = (to) => {
    setSelectedTO(to);
    if (mode === "outbound") loadOutboundData(to);
    else loadInboundData(to);
  };

  // ── UPC/SKU LOOKUPS ──
  const upcLookup = useMemo(() => {
    const m = {};
    toLines.forEach(l => { if (l.upc) m[l.upc] = l; });
    return m;
  }, [toLines]);
  const skuLookup = useMemo(() => {
    const m = {};
    toLines.forEach(l => { if (l.sku) m[l.sku.toUpperCase()] = l; });
    return m;
  }, [toLines]);

  const findItemByScan = (val) => {
    const v = val.trim();
    return upcLookup[v] || skuLookup[v.toUpperCase()] || null;
  };

  // ── OUTBOUND SCAN HANDLERS ──
  const handleBinScan = useCallback((val) => {
    if (!pickPlan || currentStop >= pickPlan.stops.length) return;
    const expected = pickPlan.stops[currentStop].bin_number;
    if (val.trim().toUpperCase() === expected.toUpperCase()) {
      setBinConfirmed(true);
      beepBin();
      setFlash("bin"); setTimeout(() => setFlash(null), 400);
    } else {
      beepWarn();
      setFlash("warn"); setTimeout(() => setFlash(null), 400);
      setError(`Wrong bin! Expected ${expected}`);
      setTimeout(() => setError(null), 3000);
    }
  }, [pickPlan, currentStop]);

  const handleItemScan = useCallback((val) => {
    const item = findItemByScan(val);
    if (!item || !pickPlan) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const stop = pickPlan.stops[currentStop];
    const pickItem = stop.items.find(i => i.item_id === item.item_id);
    if (!pickItem) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const key = `${currentStop}::${item.item_id}`;
    const current = pickedItems[key] || 0;
    if (current >= pickItem.qty) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    setPickedItems(prev => ({ ...prev, [key]: current + 1 }));
    beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
  }, [pickPlan, currentStop, pickedItems, upcLookup, skuLookup]);

  // Check if current stop is complete
  const isStopComplete = useCallback(() => {
    if (!pickPlan || currentStop >= pickPlan.stops.length) return false;
    const stop = pickPlan.stops[currentStop];
    return stop.items.every(i => (pickedItems[`${currentStop}::${i.item_id}`] || 0) >= i.qty);
  }, [pickPlan, currentStop, pickedItems]);

  // Auto-advance
  useEffect(() => {
    if (binConfirmed && isStopComplete() && pickPlan && currentStop < pickPlan.stops.length - 1) {
      const t = setTimeout(() => { setCurrentStop(p => p + 1); setBinConfirmed(false); }, 600);
      return () => clearTimeout(t);
    }
  }, [binConfirmed, isStopComplete, pickPlan, currentStop]);

  const skipBin = () => {
    if (!pickPlan || currentStop >= pickPlan.stops.length - 1) { setPhase("review"); return; }
    setCurrentStop(p => p + 1); setBinConfirmed(false);
  };

  const undoLastPick = () => {
    if (!pickPlan) return;
    const stop = pickPlan.stops[currentStop];
    for (let i = stop.items.length - 1; i >= 0; i--) {
      const key = `${currentStop}::${stop.items[i].item_id}`;
      if ((pickedItems[key] || 0) > 0) {
        setPickedItems(prev => ({ ...prev, [key]: prev[key] - 1 }));
        return;
      }
    }
  };

  // Total picked across all stops
  const totalPicked = useMemo(() => {
    return Object.values(pickedItems).reduce((s, v) => s + v, 0);
  }, [pickedItems]);
  const totalToPick = useMemo(() => {
    if (!pickPlan) return 0;
    return pickPlan.stops.reduce((s, stop) => s + stop.items.reduce((ss, i) => ss + i.qty, 0), 0);
  }, [pickPlan]);

  // ── INBOUND SCAN HANDLER ──
  const handleInboundScan = useCallback((val) => {
    const item = findItemByScan(val);
    if (!item) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const line = toLines.find(l => l.item_id === item.item_id);
    if (!line) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const current = receivedItems[item.item_id] || 0;
    if (current >= Number(line.remaining_qty)) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    setReceivedItems(prev => ({ ...prev, [item.item_id]: current + 1 }));
    beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
  }, [toLines, receivedItems, upcLookup, skuLookup]);

  const handleInboundBinScan = useCallback((itemId, binVal) => {
    setBinAssignments(prev => ({ ...prev, [itemId]: binVal.trim() }));
    setInboundBinConfirmed(prev => ({ ...prev, [itemId]: true }));
    beepBin();
  }, []);

  // ── REVIEW DATA ──
  const reviewLines = useMemo(() => {
    return toLines.map(line => {
      let scannedQty = 0;
      if (mode === "outbound" && pickPlan) {
        pickPlan.stops.forEach((stop, si) => {
          stop.items.forEach(i => {
            if (i.item_id === line.item_id) scannedQty += (pickedItems[`${si}::${i.item_id}`] || 0);
          });
        });
      } else {
        scannedQty = receivedItems[line.item_id] || 0;
      }
      const expected = Number(line.remaining_qty);
      const status = scannedQty === 0 ? "unscanned" : scannedQty < expected ? "variance" : "matched";
      return { ...line, scannedQty, expected, status, bin: binAssignments[line.item_id] || "" };
    });
  }, [toLines, mode, pickPlan, pickedItems, receivedItems, binAssignments]);

  const totalReceived = useMemo(() => Object.values(receivedItems).reduce((s, v) => s + v, 0), [receivedItems]);
  const totalToReceive = useMemo(() => toLines.reduce((s, l) => s + Number(l.remaining_qty), 0), [toLines]);

  // ── SUBMIT ──
  const handleSubmit = async () => {
    if (submitting) return; // Double-tap guard
    setSubmitting(true); setError(null);
    try {
      if (mode === "outbound") {
        await nsRecord("POST", `transferOrder/${selectedTO.internalid}/!transform/itemFulfillment`, {
          item: {
            items: reviewLines.map(line => ({
              orderLine: line.line_number,
              quantity: line.scannedQty,
              itemreceive: line.scannedQty > 0,
            })),
          },
        });
      } else {
        const items = reviewLines.filter(l => l.scannedQty > 0).map(line => {
          const entry = { orderLine: line.line_number, quantity: line.scannedQty, itemreceive: true };
          if (line.bin) {
            entry.inventoryDetail = {
              inventoryAssignment: {
                items: [{ quantity: line.scannedQty, binNumber: line.bin }],
              },
            };
          }
          return entry;
        });
        // Also include zero-qty lines with itemreceive: false
        reviewLines.filter(l => l.scannedQty === 0).forEach(line => {
          items.push({ orderLine: line.line_number, itemreceive: false });
        });
        await nsRecord("POST", `transferOrder/${selectedTO.internalid}/!transform/itemReceipt`, { item: { items } });
      }
      clearSession(SESSION_KEY);
      setSubmitResult({ success: true });
      setPhase("done");
      // Activity log
      const logAction = mode === "outbound" ? "to-fulfillment-created" : "to-receipt-created";
      const itemsList = reviewLines.filter(l => l.scannedQty > 0).map(l => ({ sku: l.sku, name: l.item_name, qty: l.scannedQty }));
      try { logActivity({ module: "transfer-orders", action: logAction, status: "success", sourceDocument: `TO #${selectedTO?.to_number}`, details: `${selectedTO?.from_location} → ${selectedTO?.to_location}, ${itemsList.length} items`, items: itemsList }); } catch (_) { }
    } catch (e) {
      setSubmitResult({ success: false, error: e.message });
      setError(`Submit failed: ${e.message}`);
      // Activity log
      const logAction = mode === "outbound" ? "to-fulfillment-failed" : "to-receipt-failed";
      try { logActivity({ module: "transfer-orders", action: logAction, status: "error", sourceDocument: `TO #${selectedTO?.to_number}`, details: `${selectedTO?.from_location} → ${selectedTO?.to_location}`, error: e.message }); } catch (_) { }
    } finally { setSubmitting(false); }
  };

  const resetModule = () => {
    clearSession(SESSION_KEY);
    setPhase("setup"); setMode(""); setSelectedLocationId(""); setSelectedLocationName("");
    setTransferOrders([]); setSelectedTO(null); setToLines([]); setPickPlan(null);
    setCurrentStop(0); setBinConfirmed(false); setPickedItems({});
    setReceivedItems({}); setBinAssignments({}); setSuggestedBins({});
    setInboundBinConfirmed({}); setSubmitResult(null); setError(null);
  };

  // ═══════════════════════════════════════════════════════════
  // RENDER HELPERS
  // ═══════════════════════════════════════════════════════════
  const Header = ({ title, backLabel, backAction }) => (
    <div style={S.hdr}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      </div>
      {backAction && <button style={S.btnSm} onClick={backAction}>← {backLabel || "Back"}</button>}
    </div>
  );

  const ProgressBar = ({ current, total, color = "#3b82f6" }) => (
    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 6, height: 8, marginBottom: 12, overflow: "hidden" }}>
      <div style={{ width: `${total > 0 ? (current / total) * 100 : 0}%`, height: "100%", background: color, borderRadius: 6, transition: "width 0.3s" }} />
    </div>
  );

  const isSalesFloor = selectedLocationName.toLowerCase().includes("sales floor");

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 — SETUP & BROWSE
  // ═══════════════════════════════════════════════════════════
  if (phase === "setup") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Transfer Orders" backLabel="Home" backAction={onBack} />
        <div style={{ padding: 16, ...fadeIn }}>
          {/* Session resume */}
          {showResume ? (
            <ResumePrompt moduleName="Transfer" onResume={handleResume} onFresh={handleFresh} />
          ) : (<>
          {error && <div style={S.err}>{error}</div>}

          {/* Location selector */}
          <label style={S.lbl}>Location</label>
          <select style={{ ...S.inp, marginBottom: 14 }} value={selectedLocationId}
            onChange={e => handleLocationChange(e.target.value)}>
            <option value="">Select location...</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>

          {/* Mode toggle */}
          <label style={S.lbl}>Direction</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {["outbound", "inbound"].map(m => (
              <button key={m} onClick={() => handleModeChange(m)} style={{
                ...S.btnSec, flex: 1, textTransform: "capitalize",
                background: mode === m ? "rgba(124,58,237,0.15)" : S.btnSec.background,
                borderColor: mode === m ? "rgba(124,58,237,0.5)" : S.btnSec.borderColor || "rgba(255,255,255,0.12)",
                color: mode === m ? "#a78bfa" : S.btnSec.color,
              }}>{m === "outbound" ? "⬆ Outbound" : "⬇ Inbound"}</button>
            ))}
          </div>

          {loading && <PulsingDot color="#7c3aed" label={loadMsg || "Loading..."} />}

          {/* TO Cards */}
          {transferOrders.length > 0 && (
            <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <button style={S.btnSm} onClick={() => { if (selectedLocationId && mode) loadTOs(selectedLocationId, mode); }}>↻ Refresh</button>
            </div>
            <div style={{ maxHeight: "calc(100vh - 380px)", overflowY: "auto" }}>
              {transferOrders.map(to => (
                <div key={to.internalid} onClick={() => selectTO(to)} style={{
                  ...S.card, cursor: "pointer", transition: "all 0.15s",
                  border: "1px solid rgba(124,58,237,0.2)", background: "rgba(124,58,237,0.03)",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{to.to_number}</span>
                    <TOBadge status={to.status} />
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                    {to.from_location} → {to.to_location}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", ...mono, marginTop: 2 }}>{to.order_date}</div>
                </div>
              ))}
            </div>
            </>
          )}
          </>)}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // LOADING SPINNER
  // ═══════════════════════════════════════════════════════════
  if (loading) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Loading..." />
        <div style={{ padding: 16, textAlign: "center", marginTop: 60 }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", border: "3px solid rgba(124,58,237,0.3)", borderTopColor: "#7c3aed", margin: "0 auto 20px", animation: "spin 1s linear infinite" }} />
          <PulsingDot color="#7c3aed" label={loadMsg || "Loading..."} />
        </div>
      </div>
    );
  }

  // PLACEHOLDER — remaining phases rendered in next section
  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — OUTBOUND BIN-GUIDED PICKING
  // ═══════════════════════════════════════════════════════════
  if (phase === "outbound" && pickPlan) {
    const stop = pickPlan.stops[currentStop];
    const allDone = currentStop >= pickPlan.stops.length;

    if (allDone || !stop) {
      // All stops complete → go to review
      if (phase !== "review") setTimeout(() => setPhase("review"), 0);
      return null;
    }

    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title={`Picking TO#${selectedTO?.to_number}`} backLabel="TOs" backAction={() => setPhase("setup")} />
        <div style={{ padding: 16 }}>
          {error && <div style={S.err}>{error}</div>}

          {/* Progress */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
            <span>Stop {currentStop + 1} of {pickPlan.stops.length}</span>
            <span>{totalPicked} / {totalToPick} picked</span>
          </div>
          <ProgressBar current={totalPicked} total={totalToPick} color="#7c3aed" />

          {/* Current stop */}
          <div style={{ ...S.card, background: "rgba(124,58,237,0.04)", border: "2px solid rgba(124,58,237,0.3)", textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 11, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>Go to Bin</div>
            <div style={{ fontSize: 28, fontWeight: 700, ...mono, color: "#a5b4fc", marginBottom: 12, letterSpacing: 1 }}>{stop.bin_number}</div>

            {!binConfirmed ? (
              <>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>Scan bin barcode to confirm</div>
                <ScanInput inputRef={scanRef} onScan={handleBinScan} placeholder="Scan bin..." flash={flash} />
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "#22c55e", marginBottom: 12 }}>✓ Bin confirmed — scan items</div>
                <ScanInput inputRef={scanRef} onScan={handleItemScan} placeholder="Scan item UPC..." flash={flash} />
                <div style={{ marginTop: 12, textAlign: "left" }}>
                  {stop.items.map((item, i) => {
                    const key = `${currentStop}::${item.item_id}`;
                    const picked = pickedItems[key] || 0;
                    const done = picked >= item.qty;
                    return (
                      <div key={item.item_id} onClick={(e) => { e.stopPropagation(); openDrawer(item.item_id); }} style={{ padding: "8px 0", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
                        opacity: done ? 0.5 : 1, cursor: "pointer", touchAction: "manipulation" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{item.sku}</div>
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.item_name}</div>
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: done ? "#22c55e" : "#e2e8f0" }}>
                            {picked}/{item.qty} {done && "✓"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={undoLastPick}>Undo Last</button>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={skipBin}>Skip Bin</button>
          </div>

          {isStopComplete() && currentStop === pickPlan.stops.length - 1 && (
            <button style={{ ...S.btn, background: "#22c55e", marginTop: 12 }} onClick={() => setPhase("review")}>
              All Picks Done → Review
            </button>
          )}
        </div>
        {DrawerComponent}
      </div>
    );
  }
  // ═══════════════════════════════════════════════════════════
  if (phase === "inbound") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title={isSalesFloor ? `Receiving to Sales Floor — ${SALES_FLOOR_BIN}` : `Receiving TO#${selectedTO?.to_number}`}
          backLabel="TOs" backAction={() => setPhase("setup")} />
        <div style={{ padding: 16 }}>
          {error && <div style={S.err}>{error}</div>}

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
            <span>{mode === "inbound" ? "Receiving" : ""}</span>
            <span>{totalReceived} / {totalToReceive} received</span>
          </div>
          <ProgressBar current={totalReceived} total={totalToReceive} color="#22c55e" />

          {isSalesFloor ? (
            /* Sales Floor — simple scan */
            <div style={{ ...S.card, background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.3)", padding: 20 }}>
              <div style={{ fontSize: 12, color: "#22c55e", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10, textAlign: "center" }}>
                Scan items — all to {SALES_FLOOR_BIN}
              </div>
              <ScanInput inputRef={scanRef} onScan={handleInboundScan} placeholder="Scan item UPC..." flash={flash} />
              <div style={{ marginTop: 12 }}>
                {toLines.map((line, i) => {
                  const rcvd = receivedItems[line.item_id] || 0;
                  const done = rcvd >= Number(line.remaining_qty);
                  return (
                    <div key={line.item_id} onClick={(e) => { e.stopPropagation(); openDrawer(line.item_id); }} style={{ padding: "8px 0", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none", opacity: done ? 0.5 : 1, cursor: "pointer", touchAction: "manipulation" }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{line.sku}</div>
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>{line.item_name}</div>
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: done ? "#22c55e" : "#e2e8f0" }}>
                          {rcvd}/{line.remaining_qty} {done && "✓"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Backroom/Warehouse — bin-guided receiving */
            <div>
              <ScanInput inputRef={scanRef} onScan={handleInboundScan} placeholder="Scan item UPC..." flash={flash} />
              <div style={{ marginTop: 12 }}>
                {toLines.map((line, i) => {
                  const rcvd = receivedItems[line.item_id] || 0;
                  const done = rcvd >= Number(line.remaining_qty);
                  const confirmed = inboundBinConfirmed[line.item_id];
                  const assignedBin = binAssignments[line.item_id] || "";
                  const suggested = suggestedBins[line.item_id];
                  return (
                    <div key={line.item_id} onClick={(e) => { e.stopPropagation(); openDrawer(line.item_id); }} style={{ ...S.card, opacity: done ? 0.6 : 1, background: done ? "rgba(34,197,94,0.04)" : S.card.background, cursor: "pointer", touchAction: "manipulation" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{line.sku}</div>
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>{line.item_name}</div>
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: done ? "#22c55e" : "#e2e8f0" }}>
                          {rcvd}/{line.remaining_qty} {done && "✓"}
                        </div>
                      </div>
                      {/* Bin assignment */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ fontSize: 10, color: "#818cf8", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, flexShrink: 0 }}>Bin:</div>
                        {confirmed ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, ...mono, color: "#a5b4fc" }}>{assignedBin}</span>
                            <button style={{ ...S.btnSm, fontSize: 10, padding: "2px 8px", minHeight: 24 }}
                              onClick={() => setInboundBinConfirmed(prev => ({ ...prev, [line.item_id]: false }))}>Change</button>
                          </div>
                        ) : (
                          <div style={{ flex: 1 }}>
                            {suggested && <div style={{ fontSize: 10, color: "#64748b", marginBottom: 4 }}>Suggested: {suggested.bin_number}</div>}
                            <input style={{ ...S.inp, fontSize: 14, padding: "8px 12px", minHeight: 36, ...mono }}
                              placeholder="Scan bin..." defaultValue={assignedBin}
                              autoComplete="off" autoCapitalize="off" spellCheck={false} inputMode="none"
                              onKeyDown={e => { if (e.key === "Enter") { handleInboundBinScan(line.item_id, e.target.value); } }} />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {totalReceived >= totalToReceive && totalToReceive > 0 && (
            <button style={{ ...S.btn, background: "#22c55e", marginTop: 12 }} onClick={() => setPhase("review")}>
              All Items Received → Review
            </button>
          )}
          {totalReceived > 0 && totalReceived < totalToReceive && (
            <button style={{ ...S.btnSec, marginTop: 12 }} onClick={() => setPhase("review")}>
              Review ({totalReceived}/{totalToReceive} received)
            </button>
          )}
        </div>
        {DrawerComponent}
      </div>
    );
  }
  // ═══════════════════════════════════════════════════════════
  if (phase === "review") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Review" backLabel="Back" backAction={() => setPhase(mode === "outbound" ? "outbound" : "inbound")} />
        <div style={{ padding: 16 }}>
          <div style={{ ...S.card, background: "rgba(124,58,237,0.04)", marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: "#e2e8f0" }}>TO#{selectedTO?.to_number}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
              {selectedTO?.from_location} → {selectedTO?.to_location}
            </div>
            <div style={{ fontSize: 11, color: "#818cf8", textTransform: "uppercase", marginTop: 4, fontWeight: 600 }}>
              {mode === "outbound" ? "Fulfillment" : "Receipt"}
            </div>
          </div>

          {reviewLines.map((line, i) => (
            <div key={line.item_id} onClick={() => openDrawer(line.item_id)} style={{
              ...S.card, padding: "10px 14px", cursor: "pointer", touchAction: "manipulation",
              borderColor: line.status === "unscanned" ? "rgba(239,68,68,0.3)" : line.status === "variance" ? "rgba(245,158,11,0.3)" : "rgba(34,197,94,0.2)",
              background: line.status === "unscanned" ? "rgba(239,68,68,0.04)" : line.status === "variance" ? "rgba(245,158,11,0.04)" : "rgba(34,197,94,0.03)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{line.sku}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8" }}>{line.item_name}</div>
                  {line.bin && <div style={{ fontSize: 10, color: "#818cf8", ...mono, marginTop: 2 }}>Bin: {line.bin}</div>}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: line.status === "matched" ? "#22c55e" : line.status === "variance" ? "#f59e0b" : "#ef4444" }}>
                    {line.scannedQty} / {line.expected}
                  </div>
                  <div style={{ fontSize: 10, textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.5,
                    color: line.status === "matched" ? "#22c55e" : line.status === "variance" ? "#f59e0b" : "#ef4444" }}>
                    {line.status}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {error && <div style={S.err}>{error}</div>}

          <button style={{ ...S.btn, background: "#22c55e", marginTop: 8 }} onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Submitting..." : mode === "outbound" ? "Create TO Fulfillment" : "Create TO Receipt"}
          </button>
          <button style={{ ...S.btnSec, marginTop: 8 }} onClick={() => setPhase(mode === "outbound" ? "outbound" : "inbound")}>
            ← Back to Scanning
          </button>
        </div>
        {DrawerComponent}
      </div>
    );
  }
  // ═══════════════════════════════════════════════════════════
  if (phase === "done") {
    if (submitResult?.success) {
      return (
        <div style={S.root}>
          <style>{FONT}{ANIMATIONS}</style>
          <Header title="Transfer Orders" />
          <div style={{ padding: 16, textAlign: "center", marginTop: 40 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(34,197,94,0.12)", border: "2px solid rgba(34,197,94,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 16px" }}>✓</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>
              {mode === "outbound" ? "Fulfillment Created" : "Receipt Created"}
            </div>
            <div style={{ fontSize: 14, color: "#94a3b8", marginBottom: 24 }}>TO#{selectedTO?.to_number}</div>
            <button style={{ ...S.btn, marginBottom: 8 }} onClick={resetModule}>Another Transfer</button>
            <button style={S.btnSec} onClick={onBack}>Home</button>
          </div>
        </div>
      );
    }
    // Error state
    return (
        <div style={S.root}>
          <style>{FONT}{ANIMATIONS}</style>
          <Header title="Transfer Orders" />
          <div style={{ padding: 16 }}>
            <div style={S.err}>{submitResult?.error || "Unknown error"}</div>
            <button style={{ ...S.btn, marginBottom: 8 }} onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Retrying..." : "Retry"}
            </button>
            <button style={S.btnSec} onClick={resetModule}>Start Over</button>
          </div>
        </div>
    );
  }

  return null;
}
