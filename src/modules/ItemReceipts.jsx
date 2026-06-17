import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  suiteql, beepOk, beepWarn,
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

  // Click-anywhere re-focus
  useScanRefocus(scanRef, phase === "receive");

  // Session resume
  const handleResume = () => {
    setShowResume(false);
    setPhase(saved?.phase || "findPO");
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
      phase, openPOs, selectedPO, poLines, currentBin, binHistory,
      receivedItems, binItems, receiptNumber, receiptSubmitted,
    });
  }, [phase, openPOs, selectedPO, poLines, currentBin, binHistory,
    receivedItems, binItems, receiptNumber, receiptSubmitted]);

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
          item.itemid AS sku, item.upccode AS upc
        FROM transactionline tl JOIN item ON tl.item = item.id
        WHERE tl.transaction = ${poId} AND tl.mainline = 'F'
          AND tl.item IS NOT NULL AND tl.quantity > 0
        ORDER BY item.itemid
      `);
      // Add remaining_qty (= ordered, since we pulled all non-zero lines)
      const lines = rows.map(r => ({ ...r, line_number: Number(r.line_number), remaining_qty: Number(r.ordered_qty) || 0, received_qty: 0 }));
      setPOLines(lines);
      if (lines.length === 0) setError("No lines on this PO.");
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
      // Send only the received items. The RESTlet transforms PO→Item
      // Receipt, matches lines by itemId, and marks everything else
      // itemreceive=false on its side. Bins go by scanned name; the
      // /api/receive-po route resolves them to internal ids (NS rejects
      // bin names, and the receipt's inventoryDetail is a static sublist
      // over raw REST — see netsuite/receivePurchaseOrder.js).
      const lines = poLines
        .filter(l => (receivedItems[l.item_id] || 0) > 0)
        .map(l => ({
          itemId: String(l.item_id),
          quantity: receivedItems[l.item_id],
          bins: (assignments[l.item_id] || []).map(b => ({ binNumber: b.bin, quantity: b.qty })),
        }));
      const resp = await fetch("/api/receive-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseOrderId: String(selectedPO.internalid), lines }),
      });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : {};
      if (!resp.ok) {
        const detail = typeof data.details === "string"
          ? data.details
          : data.details?.["o:errorDetails"]?.[0]?.detail || data.details?.message || data.error || `API error ${resp.status}`;
        throw new Error(detail);
      }
      const rNum = data?.receiptId || "Created";
      setReceiptNumber(rNum);
      setReceiptSubmitted(true);
      // Activity log
      const logLines = poLines.filter(l => (receivedItems[l.item_id] || 0) > 0);
      const binsUsed = [...new Set(Object.keys(binItems).map(k => k.split("::")[0]))];
      try { logActivity({ module: "item-receipts", action: "item-receipt-created", status: "success", sourceDocument: `PO #${selectedPO?.po_number}`, netsuiteRecord: `IR #${rNum}`, details: `${totalReceived} items received into ${binsUsed.join(", ") || "bins"}`, items: logLines.map(l => ({ sku: l.sku, name: l.item_name, qty: receivedItems[l.item_id] })) }); } catch (_) { }
      clearSession(SESSION_KEY);
      setPhase("summary");
    } catch (e) {
      setError(`Receipt failed: ${e.message}`);
      try { logActivity({ module: "item-receipts", action: "item-receipt-failed", status: "error", sourceDocument: `PO #${selectedPO?.po_number}`, details: `Failed to create receipt for ${totalReceived} items`, error: e.message }); } catch (_) { }
    }
    finally { setReceiptSubmitting(false); }
  };

  // Reset
  const resetModule = () => {
    clearSession(SESSION_KEY);
    setPhase("findPO"); setOpenPOs([]); setSelectedPO(null);
    setPOLines([]); setCurrentBin(null); setBinHistory([]); setReceivedItems({});
    setBinItems({}); setReceiptNumber(null); setReceiptSubmitting(false);
    setReceiptSubmitted(false); setError(null);
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
  // RENDER: SUMMARY
  // ═══════════════════════════════════════════════════════════
  if (phase === "summary") {
    // Clear session on entering summary
    clearSession(SESSION_KEY);

    const receivedLines = poLines.filter(l => (receivedItems[l.item_id] || 0) > 0);
    const binsUsed = [...new Set(Object.keys(binItems).map(k => k.split("::")[0]).filter(b => b && b !== "null"))];

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
            {binsUsed.length > 0 && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
                Into {binsUsed.length} bin{binsUsed.length > 1 ? "s" : ""}: <span style={{ ...mono, color: "#818cf8" }}>{binsUsed.join(", ")}</span>
              </div>
            )}

            {/* Per-line breakdown with the bins each item landed in */}
            {receivedLines.map((l, i) => {
              const itemBins = Object.entries(binItems)
                .filter(([k]) => k.endsWith(`::${l.item_id}`))
                .map(([k, q]) => ({ bin: k.split("::")[0], qty: q }));
              return (
                <div key={l.item_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0",
                  borderTop: "1px solid rgba(255,255,255,0.04)", fontSize: 13 }}>
                  <div>
                    <span style={{ ...mono, color: "#e2e8f0", fontWeight: 600 }}>{l.sku}</span>
                    {itemBins.length > 0 && (
                      <span style={{ ...mono, color: "#818cf8", fontSize: 10, marginLeft: 8 }}>
                        {itemBins.map(b => `${b.bin}(${b.qty})`).join(", ")}
                      </span>
                    )}
                  </div>
                  <span style={{ ...mono, fontWeight: 700, color: "#22c55e" }}>×{receivedItems[l.item_id]}</span>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
            Items stay in the bins you scanned. Use an Inventory Transfer to move them.
          </div>

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
