import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  suiteql, suiteqlBatched, nsRecord, beepOk, beepWarn, beepBin,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo,
  loadSession, saveSession, clearSession, ScanInput, BinScanner,
  useScanRefocus, PulsingDot, ResumePrompt,
} from "../shared";
import { useItemDetailDrawer } from "../components/ItemDetail";
import { logActivity } from "../activityLog";

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const SESSION_KEY = "glww_item_receipts";
const LOCATIONS = {
  SALES_FLOOR: { id: 1, name: "Sales Floor" },
  BACKROOM:    { id: 2, name: "Backroom" },
  WAREHOUSE:   { id: 3, name: "Warehouse" },
};
const LOC_MAP = {};
Object.values(LOCATIONS).forEach(l => { LOC_MAP[l.id] = l.name; });

const ACCENT = "#f59e0b";
const accentBg = (a = 0.04) => `rgba(245,158,11,${a})`;
const accentBc = (a = 0.3) => `rgba(245,158,11,${a})`;

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

const ProgressBar = ({ current, total, color = ACCENT }) => (
  <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 6, height: 8, marginBottom: 12, overflow: "hidden" }}>
    <div style={{ width: `${total > 0 ? (current / total) * 100 : 0}%`, height: "100%", background: color, borderRadius: 6, transition: "width 0.3s" }} />
  </div>
);

const Spinner = ({ msg, color = ACCENT }) => (
  <div style={{ padding: 16, textAlign: "center", marginTop: 60 }}>
    <div style={{ width: 64, height: 64, borderRadius: "50%", border: `3px solid ${color}40`, borderTopColor: color, margin: "0 auto 20px", animation: "spin 1s linear infinite" }} />
    <PulsingDot color={color} label={msg} />
  </div>
);

const OverBadge = () => (
  <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
    letterSpacing: 0.4, textTransform: "uppercase", color: "#a78bfa", background: "rgba(167,139,250,0.1)",
    border: "1px solid rgba(167,139,250,0.35)" }}>OVER</span>
);

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════
export default function ItemReceipts({ onBack }) {
  const saved = useRef(loadSession(SESSION_KEY)).current;
  const hasSavedSession = saved && saved.phase && saved.phase !== "findPO";

  const [showResume, setShowResume] = useState(hasSavedSession);
  const [phase, setPhase] = useState(hasSavedSession ? "findPO" : (saved?.phase || "findPO"));
  const [stage, setStage] = useState(saved?.stage || 0); // 0,1,2 for Phase 4 stages
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [error, setError] = useState(null);

  // Phase 1
  const [openPOs, setOpenPOs] = useState(saved?.openPOs || []);
  const [selectedPO, setSelectedPO] = useState(saved?.selectedPO || null);

  // Phase 2
  const [poLines, setPOLines] = useState(saved?.poLines || []);
  const [currentBin, setCurrentBin] = useState(saved?.currentBin || null);
  const [binHistory, setBinHistory] = useState(saved?.binHistory || []);
  const [receivedItems, setReceivedItems] = useState(saved?.receivedItems || {}); // "itemId" -> total count
  const [binItems, setBinItems] = useState(saved?.binItems || {}); // "bin::itemId" -> count
  const [flash, setFlash] = useState(null);
  const [receiptNumber, setReceiptNumber] = useState(saved?.receiptNumber || null);
  const [receiptSubmitting, setReceiptSubmitting] = useState(false);
  const [receiptSubmitted, setReceiptSubmitted] = useState(saved?.receiptSubmitted || false);
  const scanRef = useRef(null);
  const { openDrawer, DrawerComponent } = useItemDetailDrawer(scanRef);

  // Phase 3
  const [allocationPlan, setAllocationPlan] = useState(saved?.allocationPlan || null);
  const [suggestedBins, setSuggestedBins] = useState(saved?.suggestedBins || {}); // itemId -> bin_number

  // Phase 4
  const [pickProgress, setPickProgress] = useState(saved?.pickProgress || {}); // "stage::itemId" -> count
  const [completedStages, setCompletedStages] = useState(saved?.completedStages || []);
  const [createdTOs, setCreatedTOs] = useState(saved?.createdTOs || {}); // stage -> TO number
  const [putawayBins, setPutawayBins] = useState(saved?.putawayBins || {}); // itemId -> destination bin
  const [putawayDone, setPutawayDone] = useState(saved?.putawayDone || {}); // itemId -> true
  const [putawayCurrentBin, setPutawayCurrentBin] = useState(saved?.putawayCurrentBin || null);
  const [binTransferCount, setBinTransferCount] = useState(saved?.binTransferCount || 0);
  const [stageSubmitting, setStageSubmitting] = useState(false);

  // Click-anywhere re-focus
  useScanRefocus(scanRef, phase === "receive" || phase === "pickPutaway");

  // Session resume
  const handleResume = () => {
    setShowResume(false);
    setPhase(saved?.phase || "findPO");
    if (saved?.stage !== undefined) setStage(saved.stage);
  };
  const handleFresh = () => {
    setShowResume(false);
    clearSession(SESSION_KEY);
    resetModule();
  };

  // ── UPC/SKU LOOKUPS ──
  const upcLookup = useMemo(() => {
    const m = {};
    poLines.forEach(l => { if (l.upc) m[l.upc] = l; });
    return m;
  }, [poLines]);
  const skuLookup = useMemo(() => {
    const m = {};
    poLines.forEach(l => { if (l.sku) m[l.sku.toUpperCase()] = l; });
    return m;
  }, [poLines]);

  const findItem = (val) => {
    const v = val.trim();
    return upcLookup[v] || skuLookup[v.toUpperCase()] || null;
  };

  // ── AUTO-SAVE SESSION ──
  useEffect(() => {
    if (phase === "summary") return;
    saveSession(SESSION_KEY, {
      phase, stage, openPOs, selectedPO, poLines, currentBin, binHistory,
      receivedItems, binItems, receiptNumber, receiptSubmitted,
      allocationPlan, suggestedBins, pickProgress, completedStages, createdTOs,
      putawayBins, putawayDone, putawayCurrentBin, binTransferCount,
    });
  }, [phase, stage, openPOs, selectedPO, poLines, currentBin, binHistory,
    receivedItems, binItems, receiptNumber, receiptSubmitted,
    allocationPlan, suggestedBins, pickProgress, completedStages, createdTOs,
    putawayBins, putawayDone, putawayCurrentBin, binTransferCount]);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 — FIND PO
  // ═══════════════════════════════════════════════════════════
  const searchPO = async (val) => {
    const v = val.trim(); if (!v) return;
    setLoading(true); setError(null);
    try {
      const rows = await suiteql(`SELECT id, tranid FROM transaction WHERE type = 'PurchOrd' AND tranid = '${v.replace(/'/g, "''")}'`);
      if (rows.length > 0) {
        setSelectedPO({ internalid: rows[0].id, po_number: rows[0].tranid });
        loadPOLines(rows[0].id);
      } else {
        setError("PO not found"); setLoading(false);
      }
    } catch (e) { setError(e.message); setLoading(false); }
  };

  const loadOpenPOs = async () => {
    setLoading(true); setError(null); setLoadMsg("Loading open POs...");
    try {
      const rows = await suiteql(`
        SELECT t.id AS internalid, t.tranid AS po_number, t.trandate AS order_date,
          BUILTIN.DF(t.entity) AS vendor_name, BUILTIN.DF(t.status) AS status,
          BUILTIN.DF(t.location) AS location
        FROM transaction t
        WHERE t.type = 'PurchOrd'
          AND t.status NOT IN ('PurchOrd:G', 'PurchOrd:H')
          AND t.voided = 'F'
        ORDER BY t.trandate DESC
      `);
      setOpenPOs(rows);
      if (rows.length === 0) setError("No open POs found.");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setLoadMsg(""); }
  };

  const loadPOLines = async (poId) => {
    setLoading(true); setError(null); setLoadMsg("Loading PO lines...");
    try {
      const rows = await suiteql(`
        SELECT tl.id AS line_id, tl.linesequencenumber AS line_number, tl.item AS item_id,
          BUILTIN.DF(tl.item) AS item_name, tl.quantity AS ordered_qty,
          tl.quantityreceived AS received_qty,
          (tl.quantity - NVL(tl.quantityreceived, 0)) AS remaining_qty,
          item.itemid AS sku, item.upccode AS upc
        FROM transactionline tl JOIN item ON tl.item = item.id
        WHERE tl.transaction = ${poId} AND tl.mainline = 'F'
          AND tl.item IS NOT NULL
          AND (tl.quantity - NVL(tl.quantityreceived, 0)) > 0
        ORDER BY item.itemid
      `);
      setPOLines(rows);
      if (rows.length === 0) setError("No unreceived lines on this PO.");
      else setPhase("receive");
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setLoadMsg(""); }
  };

  const selectPO = (po) => {
    setSelectedPO(po);
    loadPOLines(po.internalid);
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — RECEIVE INTO BINS
  // ═══════════════════════════════════════════════════════════
  const handleBinScan = useCallback((val) => {
    const bin = val.trim(); if (!bin) return;
    setCurrentBin(bin);
    if (!binHistory.includes(bin)) setBinHistory(p => [...p, bin]);
  }, [binHistory]);

  const handleItemScan = useCallback((val) => {
    const item = findItem(val);
    if (!item) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const binKey = `${currentBin}::${item.item_id}`;
    setBinItems(p => ({ ...p, [binKey]: (p[binKey] || 0) + 1 }));
    setReceivedItems(p => ({ ...p, [item.item_id]: (p[item.item_id] || 0) + 1 }));
    const remaining = Number(item.remaining_qty);
    const newCount = (receivedItems[item.item_id] || 0) + 1;
    if (newCount > remaining) {
      beepWarn(); setFlash("extra");
    } else {
      beepOk(); setFlash("ok");
    }
    setTimeout(() => setFlash(null), 400);
  }, [currentBin, receivedItems, upcLookup, skuLookup, poLines]);

  const switchBin = () => setCurrentBin(null);

  const totalReceived = Object.values(receivedItems).reduce((a, b) => a + b, 0);
  const totalExpected = poLines.reduce((a, l) => a + Number(l.remaining_qty), 0);
  const overItems = poLines.filter(l => (receivedItems[l.item_id] || 0) > Number(l.remaining_qty));

  // Build bin assignment list per item for the receipt
  const getItemBinAssignments = useCallback(() => {
    const assignments = {}; // itemId -> [{bin, qty}]
    Object.entries(binItems).forEach(([key, qty]) => {
      const [bin, itemId] = key.split("::");
      if (!assignments[itemId]) assignments[itemId] = [];
      assignments[itemId].push({ bin, qty });
    });
    return assignments;
  }, [binItems]);

  const createReceipt = async () => {
    if (receiptSubmitting || receiptSubmitted) return;
    setReceiptSubmitting(true); setError(null);
    try {
      const assignments = getItemBinAssignments();
      const receivedLines = poLines.filter(l => (receivedItems[l.item_id] || 0) > 0).map(l => {
        const qty = receivedItems[l.item_id];
        const bins = assignments[l.item_id] || [];
        const entry = { orderLine: l.line_number, quantity: qty, itemreceive: true };
        if (bins.length > 0) {
          entry.inventoryDetail = {
            inventoryAssignment: {
              items: bins.map(b => ({ quantity: b.qty, binNumber: b.bin })),
            },
          };
        }
        return entry;
      });
      const unreceivedLines = poLines.filter(l => !receivedItems[l.item_id]).map(l => ({
        orderLine: l.line_number, itemreceive: false,
      }));
      const result = await nsRecord("POST", `purchaseorder/${selectedPO.internalid}/!transform/itemReceipt`, {
        item: { items: [...receivedLines, ...unreceivedLines] },
      });
      const rNum = result?.data?.tranId || result?.location?.split("/").pop() || "Created";
      setReceiptNumber(rNum);
      setReceiptSubmitted(true);
      // Activity log
      const logLines = poLines.filter(l => (receivedItems[l.item_id] || 0) > 0);
      const binsUsed = [...new Set(Object.keys(binItems).map(k => k.split("::")[0]))];
      try { logActivity({ module: "item-receipts", action: "item-receipt-created", status: "success", sourceDocument: `PO #${selectedPO?.po_number}`, netsuiteRecord: `IR #${rNum}`, details: `${totalReceived} items received into ${binsUsed.join(", ") || "bins"}`, items: logLines.map(l => ({ sku: l.sku, name: l.item_name, qty: receivedItems[l.item_id] })) }); } catch (_) { }
      // Clear receipt-specific data but keep items/bins for allocation
      setPhase("allocate");
      runAllocation();
    } catch (e) {
      setError(`Receipt failed: ${e.message}`);
      try { logActivity({ module: "item-receipts", action: "item-receipt-failed", status: "error", sourceDocument: `PO #${selectedPO?.po_number}`, details: `Failed to create receipt for ${totalReceived} items`, error: e.message }); } catch (_) { }
    }
    finally { setReceiptSubmitting(false); }
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 — SMART ALLOCATION
  // ═══════════════════════════════════════════════════════════
  const runAllocation = async () => {
    setLoading(true); setLoadMsg("Querying stock levels...");
    try {
      const itemIds = Object.keys(receivedItems);
      const { SALES_FLOOR, BACKROOM, WAREHOUSE } = LOCATIONS;
      const locIds = `${SALES_FLOOR.id},${BACKROOM.id},${WAREHOUSE.id}`;

      // Try AggregateItemLocation first
      let stockRows = [];
      try {
        stockRows = await suiteqlBatched(`
          SELECT ail.item AS item_id, ail.location AS location_id,
            BUILTIN.DF(ail.location) AS location_name,
            ail.preferredstocklevel AS preferred_level,
            ail.quantityonhand AS qty_on_hand
          FROM AggregateItemLocation ail
          WHERE ail.item IN ({IDS}) AND ail.location IN (${locIds})
        `, itemIds);
      } catch {
        // Fallback to inventory item locations
        stockRows = await suiteqlBatched(`
          SELECT il.item AS item_id, il.location AS location_id,
            BUILTIN.DF(il.location) AS location_name,
            il.preferredstocklevel AS preferred_level,
            il.quantityonhand AS qty_on_hand
          FROM InventoryItemLocations il
          WHERE il.item IN ({IDS}) AND il.location IN (${locIds})
        `, itemIds);
      }

      // Build stock map: itemId -> { locId -> { preferred, qoh } }
      const stockMap = {};
      stockRows.forEach(r => {
        if (!stockMap[r.item_id]) stockMap[r.item_id] = {};
        stockMap[r.item_id][r.location_id] = {
          preferred: Number(r.preferred_level) || 0,
          qoh: Number(r.qty_on_hand) || 0,
        };
      });

      // Allocation algorithm
      setLoadMsg("Running allocation...");
      const plan = { salesFloor: [], backroom: [], warehouse: [] };
      const itemNames = {};
      poLines.forEach(l => { itemNames[l.item_id] = { sku: l.sku, item_name: l.item_name }; });

      Object.entries(receivedItems).forEach(([itemId, totalQty]) => {
        let remaining = totalQty;
        const info = itemNames[itemId] || { sku: "?", item_name: "?" };
        const stock = stockMap[itemId] || {};

        // 1. Sales Floor first
        const sfData = stock[SALES_FLOOR.id] || { preferred: 0, qoh: 0 };
        const sfGap = Math.max(0, sfData.preferred - sfData.qoh);
        const sfAlloc = Math.min(sfGap, remaining);
        if (sfAlloc > 0) {
          plan.salesFloor.push({ item_id: itemId, ...info, qty: sfAlloc });
          remaining -= sfAlloc;
        }

        // 2. Backroom second
        const brData = stock[BACKROOM.id] || { preferred: 0, qoh: 0 };
        const brGap = Math.max(0, brData.preferred - brData.qoh);
        const brAlloc = Math.min(brGap, remaining);
        if (brAlloc > 0) {
          plan.backroom.push({ item_id: itemId, ...info, qty: brAlloc });
          remaining -= brAlloc;
        }

        // 3. Warehouse gets the rest
        if (remaining > 0) {
          plan.warehouse.push({ item_id: itemId, ...info, qty: remaining });
        }
      });

      // Query suggested bins for warehouse items
      if (plan.warehouse.length > 0) {
        setLoadMsg("Loading suggested bins...");
        const whItemIds = plan.warehouse.map(i => i.item_id);
        try {
          const binRows = await suiteqlBatched(`
            SELECT ib.item AS item_id, BUILTIN.DF(ib.binnumber) AS bin_number, ib.binnumber AS bin_id
            FROM inventorybalance ib
            WHERE ib.item IN ({IDS}) AND ib.location = ${WAREHOUSE.id}
              AND BUILTIN.DF(ib.binnumber) NOT LIKE 'IN-%' AND ib.quantityonhand > 0
            ORDER BY BUILTIN.DF(ib.binnumber) ASC
          `, whItemIds);
          const bins = {};
          binRows.forEach(r => { if (!bins[r.item_id]) bins[r.item_id] = r.bin_number; });
          setSuggestedBins(bins);
        } catch { /* no bins found */ }
      }

      setAllocationPlan(plan);
      setPhase("allocate");
    } catch (e) { setError(`Allocation failed: ${e.message}`); }
    finally { setLoading(false); setLoadMsg(""); }
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 4 — PICK & PUTAWAY
  // ═══════════════════════════════════════════════════════════
  const stageItems = useMemo(() => {
    if (!allocationPlan) return [];
    if (stage === 0) return allocationPlan.salesFloor || [];
    if (stage === 1) return allocationPlan.backroom || [];
    return allocationPlan.warehouse || [];
  }, [allocationPlan, stage]);

  const stageLabel = stage === 0 ? "Sales Floor" : stage === 1 ? "Backroom" : "Warehouse";
  const stageCompleted = completedStages.includes(stage);

  const handlePickScan = useCallback((val) => {
    const item = findItem(val);
    if (!item) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const si = stageItems.find(i => i.item_id === item.item_id);
    if (!si) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const key = `${stage}::${item.item_id}`;
    const current = pickProgress[key] || 0;
    if (current >= si.qty) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    setPickProgress(p => ({ ...p, [key]: current + 1 }));
    beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
  }, [stage, stageItems, pickProgress, upcLookup, skuLookup, poLines]);

  const pickedForStage = stageItems.reduce((s, i) => s + (pickProgress[`${stage}::${i.item_id}`] || 0), 0);
  const totalForStage = stageItems.reduce((s, i) => s + i.qty, 0);

  const createTransferOrder = async () => {
    if (stageSubmitting) return;
    setStageSubmitting(true); setError(null);
    const destLoc = stage === 0 ? LOCATIONS.SALES_FLOOR : LOCATIONS.BACKROOM;
    try {
      const result = await nsRecord("POST", "transferOrder", {
        location: { id: String(LOCATIONS.WAREHOUSE.id) },
        transferLocation: { id: String(destLoc.id) },
        memo: `Auto-created from PO#${selectedPO?.po_number} receipt`,
        item: {
          items: stageItems.map(i => ({
            item: { id: String(i.item_id) },
            quantity: i.qty,
          })),
        },
      });
      const toNum = result?.data?.tranId || result?.location?.split("/").pop() || "Created";
      setCreatedTOs(p => ({ ...p, [stage]: toNum }));
      setCompletedStages(p => [...p, stage]);
      // Activity log
      try { logActivity({ module: "item-receipts", action: "transfer-order-auto-created", status: "success", sourceDocument: `PO #${selectedPO?.po_number}`, netsuiteRecord: `TO #${toNum}`, details: `Warehouse → ${destLoc.name}, ${stageItems.length} items`, items: stageItems.map(i => ({ sku: i.sku, name: i.item_name, qty: i.qty })) }); } catch (_) { }
      // Auto advance
      if (stage < 2) setStage(p => p + 1);
      else setPhase("summary");
    } catch (e) {
      setError(`TO creation failed: ${e.message}`);
      try { logActivity({ module: "item-receipts", action: "transfer-order-failed", status: "error", sourceDocument: `PO #${selectedPO?.po_number}`, details: `Failed TO Warehouse → ${destLoc.name}`, items: stageItems.map(i => ({ sku: i.sku, name: i.item_name, qty: i.qty })), error: e.message }); } catch (_) { }
    }
    finally { setStageSubmitting(false); }
  };

  const skipStage = () => {
    setCompletedStages(p => [...p, stage]);
    if (stage < 2) setStage(p => p + 1);
    else setPhase("summary");
  };

  // Putaway handlers (stage 2)
  const handlePutawayBinScan = useCallback((val) => {
    setPutawayCurrentBin(val.trim());
    beepBin();
  }, []);

  const handlePutawayItemScan = useCallback((val) => {
    const item = findItem(val);
    if (!item) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    const whItem = stageItems.find(i => i.item_id === item.item_id);
    if (!whItem || putawayDone[item.item_id]) { beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400); return; }
    setPutawayBins(p => ({ ...p, [item.item_id]: putawayCurrentBin }));
    setPutawayDone(p => ({ ...p, [item.item_id]: true }));
    beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);

    // Create bin transfer for ALL source bins
    const itemBins = getItemBinAssignments();
    const fromBins = itemBins[item.item_id] || [];
    if (fromBins.length > 0 && putawayCurrentBin) {
      for (const fromEntry of fromBins) {
        nsRecord("POST", "inventoryTransfer", {
          location: { id: String(LOCATIONS.WAREHOUSE.id) },
          inventory: {
            items: [{
              item: { id: String(item.item_id) },
              adjustQtyBy: fromEntry.qty,
              fromBin: fromEntry.bin,
              toBin: putawayCurrentBin,
            }],
          },
        }).then(() => {
          setBinTransferCount(p => p + 1);
          try { logActivity({ module: "item-receipts", action: "bin-transfer-completed", status: "success", sourceDocument: `PO #${selectedPO?.po_number}`, details: `${item.sku} ×${fromEntry.qty}: ${fromEntry.bin} → ${putawayCurrentBin}`, items: [{ sku: item.sku, name: item.item_name, qty: fromEntry.qty }] }); } catch (_) { }
        }).catch((err) => {
          try { logActivity({ module: "item-receipts", action: "bin-transfer-failed", status: "error", sourceDocument: `PO #${selectedPO?.po_number}`, details: `${item.sku}: ${fromEntry.bin} → ${putawayCurrentBin}`, items: [{ sku: item.sku, name: item.item_name, qty: fromEntry.qty }], error: err?.message || "Unknown error" }); } catch (_) { }
        });
      }
    }
  }, [putawayCurrentBin, stageItems, putawayDone, upcLookup, skuLookup, poLines]);

  const putawayCompleteCount = Object.keys(putawayDone).length;
  const putawayTotalCount = stageItems.length;

  const finishPutaway = () => {
    setCompletedStages(p => [...p, 2]);
    clearSession(SESSION_KEY); // Clear session on all putaway complete
    setPhase("summary");
  };

  // Reset
  const resetModule = () => {
    clearSession(SESSION_KEY);
    setPhase("findPO"); setStage(0); setOpenPOs([]); setSelectedPO(null);
    setPOLines([]); setCurrentBin(null); setBinHistory([]); setReceivedItems({});
    setBinItems({}); setReceiptNumber(null); setReceiptSubmitting(false);
    setReceiptSubmitted(false); setAllocationPlan(null); setSuggestedBins({});
    setPickProgress({}); setCompletedStages([]); setCreatedTOs({});
    setPutawayBins({}); setPutawayDone({}); setPutawayCurrentBin(null);
    setBinTransferCount(0); setError(null);
  };

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 1 — FIND PO
  // ═══════════════════════════════════════════════════════════
  if (phase === "findPO") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Item Receipts" backLabel="Home" backAction={onBack} />
        <div style={{ padding: 16, ...fadeIn }}>
          {/* Session resume */}
          {showResume ? (
            <ResumePrompt moduleName="Receipt" onResume={handleResume} onFresh={handleFresh} />
          ) : (<>
          {/* Scan PO */}
          <div style={{ ...S.card, background: accentBg(0.04), border: `2px solid ${accentBc(0.3)}`, textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 12, color: ACCENT, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>Scan or Type PO Number</div>
            <ScanInput onScan={searchPO} placeholder="PO number..." flash={flash} />
          </div>

          <div style={{ textAlign: "center", padding: "12px 0", fontSize: 12, color: "#64748b" }}>— or —</div>

          <button style={{ ...S.btn, background: ACCENT }} onClick={loadOpenPOs} disabled={loading}>
            {loading ? "Loading..." : "Load Open POs"}
          </button>

          {loading && <PulsingDot color={ACCENT} label={loadMsg || "Loading..."} />}
          {error && <div style={S.err}>{error}</div>}

          {/* PO Cards */}
          {openPOs.length > 0 && (
            <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8, marginTop: 12 }}>
              <button style={S.btnSm} onClick={loadOpenPOs}>↻ Refresh</button>
            </div>
            <div style={{ maxHeight: "calc(100vh - 400px)", overflowY: "auto" }}>
              {openPOs.map(po => (
                <div key={po.internalid} onClick={() => selectPO(po)} style={{
                  ...S.card, cursor: "pointer", border: `1px solid ${accentBc(0.2)}`, background: accentBg(0.03),
                  transition: "all 0.15s",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{po.po_number}</span>
                    <span style={{ fontSize: 11, color: "#94a3b8", ...mono }}>{po.order_date}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>{po.vendor_name}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{po.status}</span>
                    <span style={{ fontSize: 11, color: "#818cf8" }}>{po.location}</span>
                  </div>
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
  // RENDER: PHASE 2 — RECEIVE INTO BINS
  // ═══════════════════════════════════════════════════════════
  if (phase === "receive") {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title={`Receiving PO#${selectedPO?.po_number}`} backLabel="POs" backAction={() => setPhase("findPO")} />
        <div style={{ padding: 16 }} onClick={() => scanRef.current?.focus()}>
          {error && <div style={S.err}>{error}</div>}

          {/* Over-receipt warning */}
          {overItems.length > 0 && (
            <div style={{ padding: "10px 14px", background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.3)",
              borderRadius: 8, fontSize: 13, color: "#a78bfa", marginBottom: 10 }}>
              ⚠ {overItems.length} item{overItems.length > 1 ? "s" : ""} over expected quantity
            </div>
          )}

          {/* Progress */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
            <span>Receiving</span>
            <span>{totalReceived} of {totalExpected} items</span>
          </div>
          <ProgressBar current={totalReceived} total={totalExpected} color={totalReceived > totalExpected ? "#a78bfa" : "#22c55e"} />

          {/* Bin Scanner */}
          <BinScanner currentBin={currentBin} onBinScan={handleBinScan} onSwitchBin={switchBin} binHistory={binHistory}>
            <ScanInput inputRef={scanRef} onScan={handleItemScan} placeholder="Scan item UPC..." flash={flash} />
          </BinScanner>

          {/* Item List */}
          <div style={{ marginTop: 12 }}>
            {poLines.map((line, i) => {
              const rcvd = receivedItems[line.item_id] || 0;
              const remaining = Number(line.remaining_qty);
              const isOver = rcvd > remaining;
              const isFull = rcvd === remaining;
              const color = isOver ? "#a78bfa" : isFull ? "#22c55e" : rcvd > 0 ? "#e2e8f0" : "#64748b";
              // Find which bins this item is in
              const itemBins = Object.entries(binItems)
                .filter(([k]) => k.endsWith(`::${line.item_id}`))
                .map(([k, q]) => ({ bin: k.split("::")[0], qty: q }));

              return (
                <div key={line.item_id} onClick={(e) => { e.stopPropagation(); openDrawer(line.item_id); }} style={{ padding: "10px 0", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  opacity: rcvd === 0 ? 0.5 : 1, cursor: "pointer", touchAction: "manipulation" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, ...mono, color }}>{line.sku}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>{line.item_name}</div>
                      {itemBins.length > 0 && (
                        <div style={{ fontSize: 10, color: "#818cf8", ...mono, marginTop: 2 }}>
                          {itemBins.map(b => `${b.bin}(${b.qty})`).join(", ")}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 8 }}>
                      {isOver && <OverBadge />}
                      <div style={{ fontSize: 16, fontWeight: 700, ...mono, color }}>
                        {rcvd}/{remaining} {isFull && "✓"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Create Receipt */}
          {totalReceived > 0 && !receiptSubmitted && (
            <button style={{ ...S.btn, background: "#22c55e", marginTop: 12, opacity: receiptSubmitting ? 0.5 : 1 }}
              onClick={createReceipt} disabled={receiptSubmitting}>
              {receiptSubmitting ? "Creating Receipt..." : `Create Receipt (${totalReceived} items)`}
            </button>
          )}
        </div>
        {DrawerComponent}
      </div>
    );
  }
  // ═══════════════════════════════════════════════════════════
  if (phase === "allocate") {
    if (loading || !allocationPlan) {
      return (
        <div style={S.root}>
          <style>{FONT}{ANIMATIONS}</style>
          <Header title="Smart Allocation" />
          <Spinner msg={loadMsg || "Running allocation..."} />
          {error && <div style={{ ...S.err, margin: 16 }}>{error}</div>}
        </div>
      );
    }

    const sfTotal = allocationPlan.salesFloor.reduce((s, i) => s + i.qty, 0);
    const brTotal = allocationPlan.backroom.reduce((s, i) => s + i.qty, 0);
    const whTotal = allocationPlan.warehouse.reduce((s, i) => s + i.qty, 0);

    const AllocSection = ({ title, items, color, icon }) => items.length === 0 ? null : (
      <div style={{ ...S.card, borderColor: `${color}40`, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color, marginBottom: 8 }}>{icon} {title} — {items.reduce((s, i) => s + i.qty, 0)} items</div>
        {items.map((item, i) => (
          <div key={item.item_id} onClick={() => openDrawer(item.item_id)} style={{ padding: "6px 0", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
            display: "flex", justifyContent: "space-between", fontSize: 12, cursor: "pointer", touchAction: "manipulation" }}>
            <div>
              <span style={{ ...mono, color: "#e2e8f0", fontWeight: 600 }}>{item.sku}</span>
              <span style={{ color: "#94a3b8", marginLeft: 8 }}>{item.item_name}</span>
            </div>
            <span style={{ ...mono, fontWeight: 700, color }}>×{item.qty}</span>
          </div>
        ))}
      </div>
    );

    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Allocation Plan" />
        <div style={{ padding: 16 }}>
          {receiptNumber && (
            <div style={{ ...S.card, background: "rgba(34,197,94,0.04)", border: "1px solid rgba(34,197,94,0.2)", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#22c55e", fontWeight: 700 }}>✓ Receipt #{receiptNumber} created</div>
            </div>
          )}

          {/* Stats */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[
              { n: sfTotal, l: "Sales Floor", c: "#22c55e" },
              { n: brTotal, l: "Backroom", c: "#3b82f6" },
              { n: whTotal, l: "Warehouse", c: ACCENT },
            ].map(s => (
              <div key={s.l} style={{ flex: 1, textAlign: "center", padding: "12px 8px", borderRadius: 8,
                background: `${s.c}10`, border: `1px solid ${s.c}30` }}>
                <div style={{ fontSize: 24, fontWeight: 700, ...mono, color: s.c }}>{s.n}</div>
                <div style={{ fontSize: 9, color: s.c, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{s.l}</div>
              </div>
            ))}
          </div>

          <AllocSection title="Pick for Sales Floor" items={allocationPlan.salesFloor} color="#22c55e" icon="⇢" />
          <AllocSection title="Pick for Backroom" items={allocationPlan.backroom} color="#3b82f6" icon="⇢" />
          <AllocSection title="Putaway at Warehouse" items={allocationPlan.warehouse.map(i => ({
            ...i, suggestedBin: suggestedBins[i.item_id] || null,
          }))} color={ACCENT} icon="↓" />

          {/* Suggested bins for warehouse items */}
          {allocationPlan.warehouse.length > 0 && (
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              {allocationPlan.warehouse.map((item, i) => (
                <div key={item.item_id} style={{ padding: "4px 0" }}>
                  <span style={{ ...mono, color: "#94a3b8" }}>{item.sku}</span>
                  <span style={{ marginLeft: 8 }}>→ {suggestedBins[item.item_id] || "No assigned bin — scan to assign"}</span>
                </div>
              ))}
            </div>
          )}

          <button style={{ ...S.btn, background: "#22c55e" }} onClick={() => {
            // Skip to first non-empty stage
            const firstNonEmpty = [0, 1, 2].find(s => {
              const items = s === 0 ? allocationPlan.salesFloor : s === 1 ? allocationPlan.backroom : allocationPlan.warehouse;
              return items.length > 0;
            });
            setStage(firstNonEmpty ?? 0);
            setPhase("pickPutaway");
          }}>
            Start Putaway →
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 4 — PICK & PUTAWAY
  // ═══════════════════════════════════════════════════════════
  if (phase === "pickPutaway") {
    // Skip completed stages
    const effectiveStage = [0, 1, 2].find(s => !completedStages.includes(s));
    if (effectiveStage !== undefined && effectiveStage !== stage) {
      setTimeout(() => setStage(effectiveStage), 0);
      return null;
    }
    if (effectiveStage === undefined) {
      setTimeout(() => setPhase("summary"), 0);
      return null;
    }

    // Stage 0 & 1: Pick for Sales Floor / Backroom
    if (stage < 2) {
      if (stageItems.length === 0) {
        // Nothing to pick, skip
        setTimeout(() => skipStage(), 0);
        return null;
      }

      return (
        <div style={S.root}>
          <style>{FONT}{ANIMATIONS}</style>
          <Header title={`Picking for ${stageLabel}`} backLabel="Allocation" backAction={() => setPhase("allocate")} />
          <div style={{ padding: 16 }}>
            {error && <div style={S.err}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
              <span>Stage {stage + 1} of 3</span>
              <span>{pickedForStage} / {totalForStage} picked</span>
            </div>
            <ProgressBar current={pickedForStage} total={totalForStage} color={stage === 0 ? "#22c55e" : "#3b82f6"} />

            <ScanInput inputRef={scanRef} onScan={handlePickScan} placeholder="Scan item UPC..." flash={flash} />

            <div style={{ marginTop: 12 }}>
              {stageItems.map((item, i) => {
                const picked = pickProgress[`${stage}::${item.item_id}`] || 0;
                const done = picked >= item.qty;
                return (
                  <div key={item.item_id} onClick={(e) => { e.stopPropagation(); openDrawer(item.item_id); }} style={{ padding: "8px 0", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none", opacity: done ? 0.5 : 1, cursor: "pointer", touchAction: "manipulation" }}>
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

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button style={{ ...S.btn, flex: 1, background: stage === 0 ? "#22c55e" : "#3b82f6",
                opacity: stageSubmitting ? 0.5 : 1 }}
                onClick={createTransferOrder} disabled={stageSubmitting || pickedForStage === 0}>
                {stageSubmitting ? "Creating TO..." : `Done Picking → Create TO`}
              </button>
            </div>
            <button style={{ ...S.btnSec, marginTop: 8 }} onClick={skipStage}>Skip for now</button>
          </div>
        </div>
      );
    }

    // Stage 2: Putaway at Warehouse
    if (stageItems.length === 0) {
      setTimeout(() => skipStage(), 0);
      return null;
    }

    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Putaway at Warehouse" backLabel="Allocation" backAction={() => setPhase("allocate")} />
        <div style={{ padding: 16 }}>
          {error && <div style={S.err}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
            <span>Stage 3 of 3 — Putaway</span>
            <span>{putawayCompleteCount} / {putawayTotalCount} shelved</span>
          </div>
          <ProgressBar current={putawayCompleteCount} total={putawayTotalCount} color={ACCENT} />

          {/* Destination bin scanner */}
          <div style={{ ...S.card, background: "rgba(99,102,241,0.04)", border: "2px solid rgba(99,102,241,0.3)", textAlign: "center", padding: 16, marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#818cf8", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 8 }}>
              {putawayCurrentBin ? "Destination Bin" : "Scan Destination Bin"}
            </div>
            {putawayCurrentBin ? (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 24, fontWeight: 700, ...mono, color: "#a5b4fc" }}>{putawayCurrentBin}</span>
                <button style={{ ...S.btnSm, fontSize: 11 }} onClick={() => setPutawayCurrentBin(null)}>Switch</button>
              </div>
            ) : (
              <ScanInput onScan={handlePutawayBinScan} placeholder="Scan bin..." />
            )}
          </div>

          {putawayCurrentBin && (
            <ScanInput inputRef={scanRef} onScan={handlePutawayItemScan} placeholder="Scan item to shelve..." flash={flash} />
          )}

          <div style={{ marginTop: 12 }}>
            {stageItems.map((item, i) => {
              const done = putawayDone[item.item_id];
              const bin = putawayBins[item.item_id] || suggestedBins[item.item_id];
              return (
                <div key={i} onClick={(e) => { e.stopPropagation(); openDrawer(item.item_id); }} style={{ padding: "10px 0", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none", opacity: done ? 0.5 : 1, cursor: "pointer", touchAction: "manipulation" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{item.sku}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.item_name}</div>
                      <div style={{ fontSize: 10, color: "#818cf8", ...mono, marginTop: 2 }}>
                        {done ? `✓ → ${putawayBins[item.item_id]}` : bin ? `Suggested: ${bin}` : "No assigned bin — scan to assign"}
                      </div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: done ? "#22c55e" : "#e2e8f0" }}>
                      ×{item.qty} {done && "✓"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button style={{ ...S.btn, background: "#22c55e", marginTop: 12 }} onClick={finishPutaway}>
            {putawayCompleteCount >= putawayTotalCount ? "All Done → Summary" : `Done (${putawayCompleteCount}/${putawayTotalCount} shelved)`}
          </button>
          <button style={{ ...S.btnSec, marginTop: 8 }} onClick={skipStage}>Skip for now</button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER: PHASE 5 — SUMMARY
  // ═══════════════════════════════════════════════════════════
  if (phase === "summary") {
    // Clear session on entering summary
    clearSession(SESSION_KEY);

    const sfItems = allocationPlan?.salesFloor || [];
    const brItems = allocationPlan?.backroom || [];
    const whItems = allocationPlan?.warehouse || [];
    const sfTotal = sfItems.reduce((s, i) => s + i.qty, 0);
    const brTotal = brItems.reduce((s, i) => s + i.qty, 0);
    const whTotal = whItems.reduce((s, i) => s + i.qty, 0);
    const pendingCount = whItems.filter(i => !putawayDone[i.item_id]).length;

    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <Header title="Receipt Complete" />
        <div style={{ padding: 16, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(34,197,94,0.12)", border: "2px solid rgba(34,197,94,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 16px" }}>✓</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#22c55e", marginBottom: 4 }}>Receipt Complete</div>
          {receiptNumber && <div style={{ fontSize: 14, color: "#94a3b8", ...mono, marginBottom: 16 }}>Receipt #{receiptNumber}</div>}

          <div style={{ ...S.card, textAlign: "left", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>Summary</div>
            <div style={{ fontSize: 14, color: "#e2e8f0", marginBottom: 8 }}>
              <strong>{totalReceived}</strong> items received on PO#{selectedPO?.po_number}
            </div>

            {/* Allocation breakdown */}
            {[
              { label: "Sales Floor", qty: sfTotal, to: createdTOs[0], color: "#22c55e", completed: completedStages.includes(0) },
              { label: "Backroom", qty: brTotal, to: createdTOs[1], color: "#3b82f6", completed: completedStages.includes(1) },
            ].map(row => row.qty > 0 && (
              <div key={row.label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0",
                borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 13 }}>
                <span style={{ color: row.color }}>{row.label}: {row.qty} items</span>
                <span style={{ color: row.completed ? "#22c55e" : "#f59e0b", ...mono, fontSize: 12 }}>
                  {row.to ? `TO#${row.to} ✓` : row.completed ? "skipped" : "pending"}
                </span>
              </div>
            ))}
            {whTotal > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0",
                borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 13 }}>
                <span style={{ color: ACCENT }}>Warehouse: {whTotal} items</span>
                <span style={{ color: "#22c55e", ...mono, fontSize: 12 }}>
                  {binTransferCount > 0 ? `${binTransferCount} bin transfers ✓` : completedStages.includes(2) ? "skipped" : "pending"}
                </span>
              </div>
            )}
          </div>

          {pendingCount > 0 && (
            <div style={{ padding: "10px 14px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)",
              borderRadius: 8, fontSize: 13, color: "#f59e0b", marginBottom: 12 }}>
              {pendingCount} item{pendingCount > 1 ? "s" : ""} still in receiving bins
            </div>
          )}

          <button style={{ ...S.btn, marginBottom: 8 }} onClick={resetModule}>Receive Another PO</button>
          <button style={S.btnSec} onClick={onBack}>Home</button>
        </div>
      </div>
    );
  }

  // Fallback
  return (
    <div style={S.root}>
      <style>{FONT}</style>
      <Header title="Item Receipts" backLabel="Home" backAction={onBack} />
      <div style={{ padding: 16, textAlign: "center", color: "#94a3b8" }}>Unknown state. <button style={S.btnSm} onClick={resetModule}>Reset</button></div>
    </div>
  );
}
