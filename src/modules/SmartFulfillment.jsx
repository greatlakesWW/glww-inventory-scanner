import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  suiteql, suiteqlBatched, nsRecord, beepOk, beepWarn,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo,
  loadSession, saveSession, clearSession, ScanInput,
  useScanRefocus, PulsingDot, ResumePrompt,
} from "../shared";
import { useItemDetailDrawer } from "../components/ItemDetail";
import { logActivity } from "../activityLog";

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const SESSION_KEY = "glww_smart_fulfillment";

// TODO: Determine actual NetSuite internal IDs for these locations.
// Run: SELECT id, name FROM location WHERE name IN ('Sales Floor', 'Backroom', 'Warehouse')
const LOCATIONS = {
  SALES_FLOOR: { id: 1, name: "Sales Floor" },
  BACKROOM:    { id: 2, name: "Backroom" },
  WAREHOUSE:   { id: 3, name: "Warehouse" },
};
const LOC_IDS = [LOCATIONS.SALES_FLOOR.id, LOCATIONS.BACKROOM.id, LOCATIONS.WAREHOUSE.id];
const LOC_PRIORITY = [LOCATIONS.SALES_FLOOR.id, LOCATIONS.BACKROOM.id, LOCATIONS.WAREHOUSE.id];
const LOC_MAP = {};
Object.values(LOCATIONS).forEach(l => { LOC_MAP[l.id] = l.name; });

// Classification colors
const CLASS_COLORS = {
  ready: { c: "#22c55e", bg: "rgba(34,197,94,0.08)", bc: "rgba(34,197,94,0.3)", label: "Ready", icon: "🟢" },
  split: { c: "#f59e0b", bg: "rgba(245,158,11,0.08)", bc: "rgba(245,158,11,0.3)", label: "Split", icon: "🟡" },
  short: { c: "#ef4444", bg: "rgba(239,68,68,0.08)", bc: "rgba(239,68,68,0.3)", label: "Short", icon: "🔴" },
};

const StatusBadge = ({ type }) => {
  const s = CLASS_COLORS[type];
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
      color: s.c, background: s.bg, border: `1px solid ${s.bc}`,
    }}>{s.icon} {s.label}</span>
  );
};

// ═══════════════════════════════════════════════════════════
// ALLOCATION ALGORITHM
// ═══════════════════════════════════════════════════════════
function allocateOrders(orders, linesByOrder, inventoryByItem) {
  // Deep-clone available inventory to track claims
  const available = {};
  Object.entries(inventoryByItem).forEach(([itemId, locs]) => {
    available[itemId] = {};
    Object.entries(locs).forEach(([locId, qty]) => { available[itemId][locId] = qty; });
  });

  const results = [];

  for (const order of orders) {
    const lines = linesByOrder[order.internalid] || [];
    if (lines.length === 0) continue;

    // Count how many items could come from each location
    const locItemCount = {};
    for (const line of lines) {
      const itemAvail = available[line.item_id] || {};
      for (const locId of LOC_IDS) {
        if ((itemAvail[locId] || 0) >= line.remaining_qty) {
          locItemCount[locId] = (locItemCount[locId] || 0) + 1;
        }
      }
    }

    // Allocate each line
    const allocations = [];
    let classification = "ready";
    const usedLocations = new Set();

    for (const line of lines) {
      const itemAvail = available[line.item_id] || {};
      let remaining = line.remaining_qty;
      const lineAllocs = [];

      // Find preferred location: most items from this order, then priority
      const sortedLocs = [...LOC_IDS].sort((a, b) => {
        const ca = locItemCount[a] || 0, cb = locItemCount[b] || 0;
        if (cb !== ca) return cb - ca;
        return LOC_PRIORITY.indexOf(a) - LOC_PRIORITY.indexOf(b);
      });

      for (const locId of sortedLocs) {
        if (remaining <= 0) break;
        const avail = itemAvail[locId] || 0;
        if (avail <= 0) continue;
        const take = Math.min(remaining, avail);
        lineAllocs.push({ location_id: locId, location_name: LOC_MAP[locId], qty: take });
        // Claim inventory
        if (!available[line.item_id]) available[line.item_id] = {};
        available[line.item_id][locId] = (available[line.item_id][locId] || 0) - take;
        remaining -= take;
        usedLocations.add(locId);
      }

      if (remaining > 0) {
        classification = "short";
        lineAllocs.push({ location_id: null, location_name: "SHORTAGE", qty: remaining });
      }

      allocations.push({ ...line, allocations: lineAllocs, short_qty: remaining });
    }

    if (classification !== "short" && usedLocations.size > 1) classification = "split";

    results.push({
      order,
      lines: allocations,
      classification,
      locations: [...usedLocations],
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
// SMART FULFILLMENT MODULE
// ═══════════════════════════════════════════════════════════
export default function SmartFulfillment({ onBack }) {
  const saved = useRef(loadSession(SESSION_KEY)).current;
  const hasSavedSession = saved && saved.phase && saved.phase !== "load";

  const [showResume, setShowResume] = useState(hasSavedSession);
  const [phase, setPhase] = useState(hasSavedSession ? "load" : (saved?.phase || "load"));
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState(null);

  // Phase 1
  const [orders, setOrders] = useState(saved?.orders || []);
  const [selectedIds, setSelectedIds] = useState(new Set(saved?.selectedIds || []));

  // Phase 2
  const [linesByOrder, setLinesByOrder] = useState(saved?.linesByOrder || {});
  const [inventoryByItem, setInventoryByItem] = useState(saved?.inventoryByItem || {});
  const [allocatedOrders, setAllocatedOrders] = useState(saved?.allocatedOrders || []);
  const [expandedOrder, setExpandedOrder] = useState(null);

  // Phase 3-4
  const [pickProgress, setPickProgress] = useState(saved?.pickProgress || {});
  const [pickingLocation, setPickingLocation] = useState(saved?.pickingLocation || null);
  const [completedLocations, setCompletedLocations] = useState(new Set(saved?.completedLocations || []));
  const [flash, setFlash] = useState(null);
  const [scanLog, setScanLog] = useState(saved?.scanLog || []);
  const scanRef = useRef(null);
  const { openDrawer, DrawerComponent } = useItemDetailDrawer(scanRef);

  // Phase 6
  const [submitResults, setSubmitResults] = useState(saved?.submitResults || null);
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState(0);
  const [submitTotal, setSubmitTotal] = useState(0);

  // Click-anywhere re-focus
  useScanRefocus(scanRef, phase === "picking");

  // Session resume handler
  const handleResume = () => {
    setShowResume(false);
    setPhase(saved?.phase || "load");
  };
  const handleFresh = () => {
    setShowResume(false);
    clearSession(SESSION_KEY);
    setOrders([]); setSelectedIds(new Set());
    setAllocatedOrders([]); setPickProgress({}); setCompletedLocations(new Set());
    setSubmitResults(null); setScanLog([]); setPickingLocation(null);
    setPhase("load");
  };

  // ── AUTO-SAVE SESSION ──
  useEffect(() => {
    if (phase === "submit" && submitResults) return; // Don't save after completion
    saveSession(SESSION_KEY, {
      phase, orders,
      selectedIds: [...selectedIds],
      linesByOrder, inventoryByItem, allocatedOrders,
      pickProgress,
      pickingLocation,
      completedLocations: [...completedLocations],
      scanLog,
    });
  }, [phase, orders, selectedIds, linesByOrder, inventoryByItem, allocatedOrders, pickProgress, pickingLocation, completedLocations, scanLog]);

  // ── BUILD PICK LIST DATA ──
  const pickListByLocation = useMemo(() => {
    const byLoc = {};
    for (const ao of allocatedOrders) {
      if (ao.classification === "short") continue;
      for (const line of ao.lines) {
        for (const alloc of line.allocations) {
          if (!alloc.location_id) continue;
          if (!byLoc[alloc.location_id]) byLoc[alloc.location_id] = {};
          const key = line.item_id;
          if (!byLoc[alloc.location_id][key]) {
            byLoc[alloc.location_id][key] = {
              item_id: line.item_id, sku: line.sku, item_name: line.item_name,
              upc: line.upc, total_qty: 0, orderBreakdown: [],
            };
          }
          byLoc[alloc.location_id][key].total_qty += alloc.qty;
          byLoc[alloc.location_id][key].orderBreakdown.push({
            order_number: ao.order.order_number, qty: alloc.qty,
          });
        }
      }
    }
    return byLoc;
  }, [allocatedOrders]);

  // UPC → item lookup
  const upcLookup = useMemo(() => {
    const m = {};
    for (const ao of allocatedOrders) {
      for (const line of ao.lines) {
        if (line.upc) m[line.upc] = line;
      }
    }
    return m;
  }, [allocatedOrders]);

  // SKU → item lookup
  const skuLookup = useMemo(() => {
    const m = {};
    for (const ao of allocatedOrders) {
      for (const line of ao.lines) {
        if (line.sku) m[line.sku.toUpperCase()] = line;
      }
    }
    return m;
  }, [allocatedOrders]);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 — LOAD ORDERS
  // ═══════════════════════════════════════════════════════════
  const loadOrders = async () => {
    setLoading(true); setError(null); setLoadMsg("Loading pending Shopify orders...");
    try {
      // NOTE: t.source = 'Shopify' filter may need adjustment depending on
      // how Shopify orders are identified in your NetSuite instance.
      const rows = await suiteql(`
        SELECT
          t.id AS internalid,
          t.tranid AS order_number,
          t.trandate AS order_date,
          BUILTIN.DF(t.entity) AS customer_name,
          BUILTIN.DF(t.status) AS status,
          t.foreigntotal AS order_total
        FROM transaction t
        WHERE t.type = 'SalesOrd'
          AND t.status IN ('SalesOrd:B', 'SalesOrd:D', 'SalesOrd:E')
          AND t.source = 'Shopify'
        ORDER BY t.trandate ASC
      `);
      setOrders(rows);
      setSelectedIds(new Set());
      if (rows.length === 0) setError("No pending Shopify orders found.");
    } catch (e) {
      setError(`Failed to load orders: ${e.message}`);
    } finally { setLoading(false); setLoadMsg(""); }
  };

  const toggleOrder = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(orders.map(o => o.internalid)));
  const deselectAll = () => setSelectedIds(new Set());

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — AUTO-LOCATE
  // ═══════════════════════════════════════════════════════════
  const buildWave = async () => {
    setPhase("locate"); setLoading(true); setError(null);

    try {
      // Step 1: Load line items (batched)
      setLoadMsg("Loading line items...");
      const idArr = [...selectedIds];
      const lines = await suiteqlBatched(`
        SELECT
          tl.transaction AS so_id,
          tl.id AS line_id,
          tl.linesequencenumber AS line_number,
          tl.item AS item_id,
          BUILTIN.DF(tl.item) AS item_name,
          tl.quantity AS ordered_qty,
          tl.quantityfulfilled AS fulfilled_qty,
          (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) AS remaining_qty,
          item.itemid AS sku,
          item.upccode AS upc
        FROM transactionline tl
        JOIN item ON tl.item = item.id
        WHERE tl.transaction IN ({IDS})
          AND tl.mainline = 'F'
          AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
          AND (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) > 0
        ORDER BY tl.transaction, item.itemid
      `, idArr);

      const grouped = {};
      const uniqueItems = new Set();
      lines.forEach(l => {
        if (!grouped[l.so_id]) grouped[l.so_id] = [];
        grouped[l.so_id].push(l);
        uniqueItems.add(l.item_id);
      });
      setLinesByOrder(grouped);

      // Step 2: Get inventory by location (batched)
      setLoadMsg(`Loading inventory for ${uniqueItems.size} items...`);
      const locIds = LOC_IDS.join(",");
      const inv = await suiteqlBatched(`
        SELECT
          ib.item AS item_id,
          ib.location AS location_id,
          BUILTIN.DF(ib.location) AS location_name,
          SUM(ib.quantityonhand) AS qty_on_hand
        FROM inventorybalance ib
        WHERE ib.item IN ({IDS})
          AND ib.location IN (${locIds})
          AND ib.quantityonhand > 0
        GROUP BY ib.item, ib.location, BUILTIN.DF(ib.location)
      `, [...uniqueItems]);

      const invMap = {};
      inv.forEach(row => {
        if (!invMap[row.item_id]) invMap[row.item_id] = {};
        invMap[row.item_id][row.location_id] = Number(row.qty_on_hand);
      });
      setInventoryByItem(invMap);

      // Step 3: Allocation
      setLoadMsg("Allocating inventory...");
      const selectedOrders = orders.filter(o => selectedIds.has(o.internalid));
      const result = allocateOrders(selectedOrders, grouped, invMap);
      setAllocatedOrders(result);
      setPickProgress({});
      setCompletedLocations(new Set());
      setLoading(false); setLoadMsg("");

      // Activity log
      try {
        const ready = result.filter(ao => ao.classification === "ready").length;
        const split = result.filter(ao => ao.classification === "split").length;
        const short = result.filter(ao => ao.classification === "short").length;
        const totalItems = result.reduce((s, ao) => s + ao.lines.reduce((ss, l) => ss + Number(l.remaining_qty), 0), 0);
        logActivity({
          module: "smart-fulfillment", action: "wave-built", status: "success",
          sourceDocument: `${idArr.length} orders`,
          details: `Wave: ${ready} ready, ${split} split, ${short} short — ${totalItems} total items`,
          items: result.flatMap(ao => ao.lines.map(l => ({ sku: l.sku, name: l.item_name, qty: Number(l.remaining_qty) }))),
        });
      } catch (e) { /* never block */ }
    } catch (e) {
      setError(`Failed: ${e.message}`);
      setLoading(false); setLoadMsg("");
    }
  };

  const removeShortOrders = () => {
    setAllocatedOrders(prev => prev.filter(ao => ao.classification !== "short"));
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 4 — PICK SCANNING
  // ═══════════════════════════════════════════════════════════
  const startPicking = (locId) => {
    setPickingLocation(locId);
    setPhase("picking");
  };

  const handleScan = useCallback((val) => {
    const trimmed = val.trim();
    if (!trimmed) return;

    // Try UPC match
    let matchedItem = upcLookup[trimmed];

    // Try SKU match
    if (!matchedItem) {
      matchedItem = skuLookup[trimmed.toUpperCase()];
    }

    if (!matchedItem) {
      beepWarn();
      setFlash("warn");
      setTimeout(() => setFlash(null), 400);
      return;
    }

    const locItems = pickListByLocation[pickingLocation] || {};
    const pickItem = locItems[matchedItem.item_id];

    if (!pickItem) {
      beepWarn();
      setFlash("warn");
      setTimeout(() => setFlash(null), 400);
      return;
    }

    const key = `${pickingLocation}::${matchedItem.item_id}`;
    const current = pickProgress[key] || 0;

    if (current >= pickItem.total_qty) {
      beepWarn();
      setFlash("warn");
      setTimeout(() => setFlash(null), 400);
      return;
    }

    setPickProgress(prev => ({ ...prev, [key]: current + 1 }));
    setScanLog(prev => [{ item: matchedItem.sku, time: Date.now() }, ...prev.slice(0, 99)]);
    beepOk();
    setFlash("ok");
    setTimeout(() => setFlash(null), 400);
  }, [pickingLocation, pickListByLocation, pickProgress, upcLookup, skuLookup]);

  const undoLast = () => {
    if (scanLog.length === 0) return;
    const last = scanLog[0];
    // Find item by sku
    const item = skuLookup[last.item?.toUpperCase()];
    if (item) {
      const key = `${pickingLocation}::${item.item_id}`;
      setPickProgress(prev => {
        const cur = prev[key] || 0;
        if (cur <= 0) return prev;
        return { ...prev, [key]: cur - 1 };
      });
    }
    setScanLog(prev => prev.slice(1));
  };

  const finishLocationPick = () => {
    setCompletedLocations(prev => new Set([...prev, pickingLocation]));
    setPickingLocation(null);
    setPhase("picklist");
  };

  // Manual SKU entry
  const [showManual, setShowManual] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const manualRef = useRef(null);

  const handleManualAdd = () => {
    const trimmed = manualSku.trim().toUpperCase();
    if (!trimmed) return;
    const match = skuLookup[trimmed];
    if (match) {
      handleScan(match.upc || match.sku);
      setManualSku("");
      setShowManual(false);
    } else {
      setError(`SKU "${trimmed}" not found in pick list.`);
    }
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 6 — SUBMIT FULFILLMENTS
  // ═══════════════════════════════════════════════════════════
  const buildFulfillments = () => {
    const fulfillments = [];
    for (const ao of allocatedOrders) {
      if (ao.classification === "short") continue;
      // Group lines by location
      const locLines = {};
      for (const line of ao.lines) {
        for (const alloc of line.allocations) {
          if (!alloc.location_id) continue;
          if (!locLines[alloc.location_id]) locLines[alloc.location_id] = [];
          locLines[alloc.location_id].push({ ...line, picked_qty: alloc.qty, location_id: alloc.location_id });
        }
      }
      // One fulfillment per location
      for (const [locId, lines] of Object.entries(locLines)) {
        fulfillments.push({
          so_id: ao.order.internalid,
          order_number: ao.order.order_number,
          customer_name: ao.order.customer_name,
          location_id: Number(locId),
          location_name: LOC_MAP[locId],
          lines,
          // All lines for this SO (to set itemreceive: false on others)
          allLines: ao.lines,
        });
      }
    }
    return fulfillments;
  };

  const fulfillments = useMemo(buildFulfillments, [allocatedOrders]);

  const submitFulfillments = async () => {
    if (submitting) return; // Double-tap guard
    setSubmitting(true);
    setSubmitProgress(0);
    setSubmitTotal(fulfillments.length);
    const results = [];

    for (let i = 0; i < fulfillments.length; i++) {
      const f = fulfillments[i];
      setSubmitProgress(i + 1);
      try {
        // IMPORTANT: NetSuite includes ALL unfulfilled lines by default.
        // We MUST set itemreceive: false on lines not being fulfilled in this request.
        const fulfilledLineNumbers = new Set(f.lines.map(l => l.line_number));

        const items = f.lines.map(line => ({
          orderLine: line.line_number,
          location: f.location_id,
          quantity: line.picked_qty,
          itemreceive: true,
        })).concat(
          f.allLines
            .filter(line => !fulfilledLineNumbers.has(line.line_number))
            .map(line => ({
              orderLine: line.line_number,
              itemreceive: false,
            }))
        );

        await nsRecord("POST", `salesorder/${f.so_id}/!transform/itemFulfillment`, {
          item: { items },
        });

        results.push({ ...f, success: true });
        try { logActivity({ module: "smart-fulfillment", action: "fulfillment-created", status: "success", sourceDocument: `SO #${f.order_number}`, netsuiteRecord: `Fulfillment`, details: `${f.lines.length} items from ${f.location_name}`, items: f.lines.map(l => ({ sku: l.sku, name: l.item_name, qty: l.picked_qty })) }); } catch (_) { }
      } catch (e) {
        results.push({ ...f, success: false, error: e.message });
        try { logActivity({ module: "smart-fulfillment", action: "fulfillment-failed", status: "error", sourceDocument: `SO #${f.order_number}`, details: `Failed fulfillment from ${f.location_name}`, items: f.lines.map(l => ({ sku: l.sku, name: l.item_name, qty: l.picked_qty })), error: e.message }); } catch (_) { }
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      // All succeeded — clear entire session
      clearSession(SESSION_KEY);
    } else {
      // Keep only failed orders for retry
      const failedSoIds = new Set(failed.map(r => r.so_id));
      const retryOrders = allocatedOrders.filter(ao => failedSoIds.has(ao.order.internalid));
      setAllocatedOrders(retryOrders);
      saveSession(SESSION_KEY, {
        phase: "review", orders, selectedIds: [...selectedIds],
        linesByOrder, inventoryByItem,
        allocatedOrders: retryOrders,
        pickProgress, pickingLocation: null,
        completedLocations: [...completedLocations],
        scanLog,
      });
    }

    setSubmitResults({ results, succeeded, failed: failed.length, total: results.length });
    setSubmitting(false);
    setPhase("submit");
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

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 1 — LOAD ORDERS
  // ═══════════════════════════════════════════════════════════
  if (phase === "load") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Smart Fulfillment" backLabel="Home" backAction={onBack} />
        <div style={{ padding: 16, ...fadeIn }}>
          {/* Session resume prompt */}
          {showResume ? (
            <ResumePrompt moduleName="Fulfillment" onResume={handleResume} onFresh={handleFresh} />
          ) : orders.length === 0 ? (
            <div style={S.card}>
              <p style={{ fontSize: 14, color: "#94a3b8", marginBottom: 14 }}>
                Load pending Shopify orders from NetSuite to start building a fulfillment wave.
              </p>
              {loading && <PulsingDot color="#22c55e" label={loadMsg || "Loading..."} />}
              {error && <div style={S.err}>{error}</div>}
              <button style={S.btn} onClick={loadOrders} disabled={loading}>
                {loading ? "Loading..." : "Load Pending Orders"}
              </button>
            </div>
          ) : (
            <>
              {error && <div style={S.err}>{error}</div>}

              {/* Select All / Deselect All + Refresh */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button style={{ ...S.btnSm, flex: 1 }} onClick={selectAll}>Select All</button>
                <button style={{ ...S.btnSm, flex: 1 }} onClick={deselectAll}>Deselect All</button>
                <button style={{ ...S.btnSm }} onClick={() => { setOrders([]); setSelectedIds(new Set()); }}>↻</button>
              </div>

              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 10, textAlign: "center" }}>
                <span style={{ fontWeight: 700, color: "#60a5fa", ...mono }}>{selectedIds.size}</span> of {orders.length} orders selected
              </div>

              {/* Order cards */}
              <div style={{ maxHeight: "calc(100vh - 300px)", overflowY: "auto", marginBottom: 12 }}>
                {orders.map(o => {
                  const sel = selectedIds.has(o.internalid);
                  return (
                    <div key={o.internalid} onClick={() => toggleOrder(o.internalid)} style={{
                      ...S.card,
                      cursor: "pointer",
                      border: sel ? "1px solid rgba(59,130,246,0.5)" : S.card.border,
                      background: sel ? "rgba(59,130,246,0.06)" : S.card.background,
                      display: "flex", alignItems: "center", gap: 12,
                      transition: "all 0.15s",
                    }}>
                      {/* Checkbox */}
                      <div style={{
                        width: 22, height: 22, borderRadius: 4, flexShrink: 0,
                        border: sel ? "2px solid #3b82f6" : "2px solid rgba(255,255,255,0.2)",
                        background: sel ? "#3b82f6" : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, color: "#fff", transition: "all 0.15s",
                      }}>{sel ? "✓" : ""}</div>
                      {/* Info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                          <span style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{o.order_number}</span>
                          <span style={{ fontSize: 14, fontWeight: 700, ...mono, color: "#22c55e" }}>${Number(o.order_total || 0).toFixed(2)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{o.customer_name}</div>
                        <div style={{ fontSize: 11, color: "#64748b", ...mono, marginTop: 2 }}>{o.order_date}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Build Wave */}
              <button
                style={{ ...S.btn, background: "#22c55e", opacity: selectedIds.size > 0 ? 1 : 0.4 }}
                onClick={buildWave}
                disabled={selectedIds.size === 0}
              >
                Build Wave ({selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""})
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 2 — LOCATE (loading or results)
  // ═══════════════════════════════════════════════════════════
  if (phase === "locate") {
    if (loading) {
      return (
        <div style={S.root}>
          <style>{FONT}{ANIMATIONS}</style>
          <Header title="Locating Inventory" />
          <div style={{ padding: 16, textAlign: "center", marginTop: 60 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", border: "3px solid rgba(59,130,246,0.3)", borderTopColor: "#3b82f6", margin: "0 auto 20px", animation: "spin 1s linear infinite" }} />
            <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0", marginBottom: 8 }}>Auto-Locating Inventory</div>
            <PulsingDot color="#3b82f6" label={loadMsg || "Loading..."} />
            {error && <div style={{ ...S.err, marginTop: 16 }}>{error}</div>}
          </div>
        </div>
      );
    }

    // Results
    const ready = allocatedOrders.filter(ao => ao.classification === "ready").length;
    const split = allocatedOrders.filter(ao => ao.classification === "split").length;
    const short = allocatedOrders.filter(ao => ao.classification === "short").length;

    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <Header title="Allocation Results" backLabel="Orders" backAction={() => setPhase("load")} />
        <div style={{ padding: 16 }}>
          {error && <div style={S.err}>{error}</div>}

          {/* Stats */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[
              { n: ready, l: "Ready", c: "#22c55e" },
              { n: split, l: "Split", c: "#f59e0b" },
              { n: short, l: "Short", c: "#ef4444" },
            ].map(s => (
              <div key={s.l} style={{
                flex: 1, textAlign: "center", padding: "12px 8px", borderRadius: 8,
                background: `${s.c}10`, border: `1px solid ${s.c}30`,
              }}>
                <div style={{ fontSize: 24, fontWeight: 700, ...mono, color: s.c }}>{s.n}</div>
                <div style={{ fontSize: 10, color: s.c, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{s.l}</div>
              </div>
            ))}
          </div>

          {/* Order list */}
          <div style={{ maxHeight: "calc(100vh - 340px)", overflowY: "auto", marginBottom: 12 }}>
            {allocatedOrders.map((ao, idx) => {
              const isExpanded = expandedOrder === idx;
              return (
                <div key={idx} style={{
                  ...S.card,
                  borderColor: CLASS_COLORS[ao.classification].bc,
                  background: CLASS_COLORS[ao.classification].bg,
                  cursor: "pointer",
                }} onClick={() => setExpandedOrder(isExpanded ? null : idx)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 14, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{ao.order.order_number}</span>
                      <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8 }}>{ao.order.customer_name}</span>
                    </div>
                    <StatusBadge type={ao.classification} />
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                    {ao.lines.length} item{ao.lines.length !== 1 ? "s" : ""} • {ao.locations.map(l => LOC_MAP[l]).join(", ")}
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
                      {ao.lines.map((line, li) => (
                        <div key={li} style={{ padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span style={{ ...mono, color: "#e2e8f0" }}>{line.sku}</span>
                            <span style={{ color: "#94a3b8" }}>×{line.remaining_qty}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{line.item_name}</div>
                          {line.allocations.map((a, ai) => (
                            <div key={ai} style={{
                              fontSize: 11, marginTop: 2, paddingLeft: 8,
                              color: a.location_id ? "#94a3b8" : "#ef4444",
                            }}>
                              → {a.location_name}: {a.qty}
                              {!a.location_id && <span style={{ color: "#ef4444", fontWeight: 700 }}> (SHORT)</span>}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Actions */}
          {short > 0 && (
            <button style={{ ...S.btnSec, marginBottom: 8, borderColor: "rgba(239,68,68,0.3)", color: "#f87171" }} onClick={removeShortOrders}>
              Remove Short Orders ({short})
            </button>
          )}
          <button
            style={{ ...S.btn, background: "#22c55e", opacity: allocatedOrders.some(ao => ao.classification !== "short") ? 1 : 0.4 }}
            onClick={() => {
              // If all items at one location, skip picklist and go straight to picking
              const locs = LOC_PRIORITY.filter(id => pickListByLocation[id]);
              if (locs.length === 1) { startPicking(locs[0]); return; }
              setPhase("picklist");
            }}
            disabled={!allocatedOrders.some(ao => ao.classification !== "short")}
          >
            Continue to Pick List →
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 3 — WAVE PICK LIST
  // ═══════════════════════════════════════════════════════════
  if (phase === "picklist") {
    const totalItems = Object.values(pickListByLocation).reduce((sum, items) => sum + Object.values(items).reduce((s, i) => s + i.total_qty, 0), 0);
    const allLocsDone = LOC_PRIORITY.filter(id => pickListByLocation[id]).every(id => completedLocations.has(id));

    return (
      <div style={S.root}>
        <style>{FONT}</style>
        <Header title="Wave Pick List" backLabel="Allocations" backAction={() => setPhase("locate")} />
        <div style={{ padding: 16 }}>
          <div style={{ textAlign: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: "#94a3b8" }}>Total items to pick: </span>
            <span style={{ fontSize: 18, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{totalItems}</span>
          </div>

          {LOC_PRIORITY.map(locId => {
            const items = pickListByLocation[locId];
            if (!items) return null;
            const itemList = Object.values(items);
            const itemCount = itemList.reduce((s, i) => s + i.total_qty, 0);
            const done = completedLocations.has(locId);

            return (
              <div key={locId} style={{
                ...S.card,
                borderColor: done ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)",
                background: done ? "rgba(34,197,94,0.04)" : S.card.background,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
                      {done && <span style={{ color: "#22c55e", marginRight: 6 }}>✓</span>}
                      {LOC_MAP[locId]}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{itemCount} items • {itemList.length} SKUs</div>
                  </div>
                  <button
                    style={{ ...S.btnSm, background: done ? "rgba(34,197,94,0.1)" : "rgba(59,130,246,0.15)", color: done ? "#22c55e" : "#60a5fa", borderColor: done ? "rgba(34,197,94,0.3)" : "rgba(59,130,246,0.3)" }}
                    onClick={() => startPicking(locId)}
                  >
                    {done ? "Re-Pick" : "Start Picking"}
                  </button>
                </div>

                {/* Item list */}
                {itemList.map((item, i) => (
                  <div key={i} onClick={() => openDrawer(item.item_id)} style={{ padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 12, cursor: "pointer", touchAction: "manipulation" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ ...mono, fontWeight: 600, color: "#e2e8f0" }}>{item.sku}</span>
                      <span style={{ ...mono, fontWeight: 700, color: "#60a5fa" }}>×{item.total_qty}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.item_name}</div>
                    {item.upc && <div style={{ fontSize: 10, color: "#64748b", ...mono }}>UPC: {item.upc}</div>}
                    {item.orderBreakdown.length > 1 && (
                      <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                        {item.orderBreakdown.map(ob => `${ob.order_number} (×${ob.qty})`).join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          {allLocsDone && (
            <button style={{ ...S.btn, background: "#22c55e", marginTop: 8 }} onClick={() => setPhase("review")}>
              Review & Submit →
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 4 — PICKING
  // ═══════════════════════════════════════════════════════════
  if (phase === "picking") {
    const locItems = pickListByLocation[pickingLocation] || {};
    const itemList = Object.values(locItems);
    const totalQty = itemList.reduce((s, i) => s + i.total_qty, 0);
    const pickedQty = itemList.reduce((s, i) => {
      const key = `${pickingLocation}::${i.item_id}`;
      return s + (pickProgress[key] || 0);
    }, 0);

    // Sort: unpicked first, then fully picked
    const sortedItems = [...itemList].sort((a, b) => {
      const aKey = `${pickingLocation}::${a.item_id}`;
      const bKey = `${pickingLocation}::${b.item_id}`;
      const aDone = (pickProgress[aKey] || 0) >= a.total_qty;
      const bDone = (pickProgress[bKey] || 0) >= b.total_qty;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return 0;
    });

    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header
          title={`Picking — ${LOC_MAP[pickingLocation]}`}
          backLabel="Pick List"
          backAction={() => { setPickingLocation(null); setPhase("picklist"); }}
        />
        <div style={{ padding: 16 }}>
          {/* Progress bar */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
              <span>Progress</span>
              <span style={{ ...mono, fontWeight: 700, color: "#e2e8f0" }}>{pickedQty} / {totalQty}</span>
            </div>
            <div style={{ height: 8, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 4, transition: "width 0.3s",
                width: totalQty > 0 ? `${(pickedQty / totalQty) * 100}%` : "0%",
                background: pickedQty >= totalQty ? "#22c55e" : "#3b82f6",
              }} />
            </div>
          </div>

          {/* Scanner */}
          {!showManual && (
            <div style={{ marginBottom: 12 }}>
              <ScanInput inputRef={scanRef} onScan={handleScan} placeholder="Scan UPC..." flash={flash} />
            </div>
          )}

          {error && <div style={S.err}>{error}</div>}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={undoLast} disabled={scanLog.length === 0}>↩ Undo Last</button>
            <button style={{ ...S.btnSm, flex: 1 }} onClick={() => { setShowManual(!showManual); setError(null); }}>
              {showManual ? "Cancel" : "⌨ Manual SKU"}
            </button>
          </div>

          {/* Manual entry */}
          {showManual && (
            <div style={{ ...S.card, background: "rgba(59,130,246,0.04)", border: "1px solid rgba(59,130,246,0.3)", marginBottom: 12 }}>
              <label style={S.lbl}>Enter SKU</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  ref={manualRef}
                  style={{ ...S.inp, flex: 1, ...mono }}
                  placeholder="SKU..."
                  value={manualSku}
                  onChange={e => setManualSku(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleManualAdd(); }}
                  autoFocus
                />
                <button style={{ ...S.btnSm, padding: "8px 16px" }} onClick={handleManualAdd}>Add</button>
              </div>
            </div>
          )}

          {/* Items */}
          <div style={{ maxHeight: "calc(100vh - 360px)", overflowY: "auto" }}>
            {sortedItems.map((item, i) => {
              const key = `${pickingLocation}::${item.item_id}`;
              const picked = pickProgress[key] || 0;
              const done = picked >= item.total_qty;
              return (
                <div key={item.item_id} onClick={(e) => { e.stopPropagation(); openDrawer(item.item_id); }} style={{
                  ...S.card,
                  marginBottom: 6,
                  borderColor: done ? "rgba(34,197,94,0.3)" : picked > 0 ? "rgba(59,130,246,0.2)" : "rgba(255,255,255,0.06)",
                  background: done ? "rgba(34,197,94,0.04)" : picked > 0 ? "rgba(59,130,246,0.03)" : S.card.background,
                  opacity: done ? 0.7 : 1, cursor: "pointer", touchAction: "manipulation",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: done ? "#22c55e" : "#e2e8f0" }}>
                        {done && "✓ "}{item.sku}
                      </div>
                      <div style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.item_name}</div>
                      {item.upc && <div style={{ fontSize: 10, color: "#64748b", ...mono }}>UPC: {item.upc}</div>}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 8 }}>
                      <div style={{ fontSize: 22, fontWeight: 700, ...mono, color: done ? "#22c55e" : picked > 0 ? "#60a5fa" : "#94a3b8" }}>
                        {picked}/{item.total_qty}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Done button */}
          {pickedQty >= totalQty && (
            <button style={{ ...S.btn, background: "#22c55e", marginTop: 12 }} onClick={finishLocationPick}>
              ✓ Done — Return to Pick List
            </button>
          )}
        </div>
        {DrawerComponent}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 5 — REVIEW
  // ═══════════════════════════════════════════════════════════
  if (phase === "review") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Review Fulfillments" />
        <div style={{ padding: 16 }}>
          {/* Stats */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1, textAlign: "center", padding: "12px 8px", borderRadius: 8, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)" }}>
              <div style={{ fontSize: 22, fontWeight: 700, ...mono, color: "#60a5fa" }}>{allocatedOrders.filter(ao => ao.classification !== "short").length}</div>
              <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase" }}>Orders</div>
            </div>
            <div style={{ flex: 1, textAlign: "center", padding: "12px 8px", borderRadius: 8, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)" }}>
              <div style={{ fontSize: 22, fontWeight: 700, ...mono, color: "#22c55e" }}>{fulfillments.length}</div>
              <div style={{ fontSize: 10, color: "#94a3b8", textTransform: "uppercase" }}>Fulfillments</div>
            </div>
          </div>

          {/* By Sales Order */}
          <div style={{ maxHeight: "calc(100vh - 320px)", overflowY: "auto", marginBottom: 12 }}>
            {allocatedOrders.filter(ao => ao.classification !== "short").map((ao, idx) => {
              // Group lines by location
              const locGroups = {};
              ao.lines.forEach(line => {
                line.allocations.forEach(alloc => {
                  if (!alloc.location_id) return;
                  if (!locGroups[alloc.location_id]) locGroups[alloc.location_id] = [];
                  locGroups[alloc.location_id].push({ ...line, fulfilQty: alloc.qty });
                });
              });

              return (
                <div key={idx} style={S.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{ao.order.order_number}</span>
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>{ao.order.customer_name}</span>
                  </div>

                  {Object.entries(locGroups).map(([locId, lines]) => {
                    const allPicked = lines.every(l => {
                      const key = `${locId}::${l.item_id}`;
                      return (pickProgress[key] || 0) >= l.fulfilQty;
                    });
                    const somePicked = lines.some(l => {
                      const key = `${locId}::${l.item_id}`;
                      return (pickProgress[key] || 0) > 0;
                    });

                    return (
                      <div key={locId} style={{
                        borderRadius: 6, padding: "8px 10px", marginBottom: 6,
                        background: allPicked ? "rgba(34,197,94,0.06)" : somePicked ? "rgba(245,158,11,0.06)" : "rgba(239,68,68,0.06)",
                        border: `1px solid ${allPicked ? "rgba(34,197,94,0.2)" : somePicked ? "rgba(245,158,11,0.2)" : "rgba(239,68,68,0.2)"}`,
                      }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: allPicked ? "#22c55e" : somePicked ? "#f59e0b" : "#ef4444", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                          {allPicked ? "✓" : somePicked ? "◐" : "○"} {LOC_MAP[locId]}
                        </div>
                        {lines.map((line, li) => (
                          <div key={li} onClick={(e) => { e.stopPropagation(); openDrawer(line.item_id); }} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", color: "#e2e8f0", cursor: "pointer", touchAction: "manipulation" }}>
                            <span style={mono}>{line.sku}</span>
                            <span style={{ color: "#94a3b8", ...mono }}>×{line.fulfilQty} → {LOC_MAP[locId]}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Actions — no back path from here */}
          <button
            style={{ ...S.btn, background: "#22c55e", opacity: submitting ? 0.5 : 1 }}
            onClick={submitFulfillments}
            disabled={submitting}
          >
            {submitting ? `Creating ${submitProgress} of ${submitTotal}...` : `Create ${fulfillments.length} Fulfillment${fulfillments.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 6 — SUBMIT RESULTS
  // ═══════════════════════════════════════════════════════════
  if (phase === "submit") {
    if (submitting) {
      return (
        <div style={S.root}>
          <style>{FONT}{ANIMATIONS}</style>
          <Header title="Creating Fulfillments" />
          <div style={{ padding: 16, textAlign: "center", marginTop: 60 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", border: "3px solid rgba(34,197,94,0.3)", borderTopColor: "#22c55e", margin: "0 auto 20px", animation: "spin 1s linear infinite" }} />
            <PulsingDot color="#22c55e" label={`Creating fulfillment ${submitProgress} of ${submitTotal}...`} />
          </div>
        </div>
      );
    }

    if (!submitResults) return null;

    const { results, succeeded, failed, total } = submitResults;

    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Fulfillment Results" />
        <div style={{ padding: 16 }}>
          {/* Summary */}
          <div style={{
            ...S.card, textAlign: "center", padding: 24,
            background: failed > 0 ? "rgba(245,158,11,0.06)" : "rgba(34,197,94,0.06)",
            border: `1px solid ${failed > 0 ? "rgba(245,158,11,0.3)" : "rgba(34,197,94,0.3)"}`,
          }}>
            <div style={{ fontSize: 42, marginBottom: 8 }}>{failed === 0 ? "✅" : "⚠️"}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>
              {succeeded} of {total} Created
            </div>
            {failed > 0 && (
              <div style={{ fontSize: 13, color: "#f59e0b" }}>{failed} failed — see details below</div>
            )}
          </div>

          {/* Per-fulfillment results */}
          <div style={{ maxHeight: "calc(100vh - 360px)", overflowY: "auto", marginTop: 12 }}>
            {results.map((r, i) => (
              <div key={i} style={{
                ...S.card, marginBottom: 6,
                borderColor: r.success ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.3)",
                background: r.success ? "rgba(34,197,94,0.03)" : "rgba(239,68,68,0.05)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{r.order_number}</span>
                    <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>→ {r.location_name}</span>
                  </div>
                  <span style={{ fontSize: 18 }}>{r.success ? "✅" : "❌"}</span>
                </div>
                {!r.success && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 4, ...mono }}>{r.error}</div>
                )}
              </div>
            ))}
          </div>

          {/* Actions — NO re-submit path */}
          <div style={{ marginTop: 12 }}>
            {failed > 0 && (
              <button style={{ ...S.btn, background: "#f59e0b", marginBottom: 8 }} onClick={() => setPhase("review")}>
                Retry Failed ({failed})
              </button>
            )}
            <button style={{ ...S.btn, background: "#22c55e", marginBottom: 8 }} onClick={() => {
              clearSession(SESSION_KEY);
              setPhase("load"); setOrders([]); setSelectedIds(new Set());
              setAllocatedOrders([]); setPickProgress({}); setCompletedLocations(new Set());
              setSubmitResults(null); setScanLog([]);
            }}>
              Start New Wave
            </button>
            <button style={S.btnSec} onClick={() => { clearSession(SESSION_KEY); onBack(); }}>
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
