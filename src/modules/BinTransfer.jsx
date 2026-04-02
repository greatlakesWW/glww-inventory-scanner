import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  suiteql, nsRecord,
  beepOk, beepWarn, beepBin,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo,
  loadSession, saveSession, clearSession,
  ScanInput, useScanRefocus, PulsingDot, ResumePrompt,
} from "../shared";
import { useItemDetailDrawer } from "../components/ItemDetail";
import { logActivity } from "../activityLog";

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const SESSION_KEY = "glww_bin_transfer";
const ACCENT = "#14b8a6"; // teal

// ═══════════════════════════════════════════════════════════
// BIN TRANSFER MODULE
// ═══════════════════════════════════════════════════════════
export default function BinTransfer({ onBack }) {
  const saved = useRef(loadSession(SESSION_KEY)).current;
  const hasSavedSession = saved && saved.phase && saved.phase !== "location";

  // ── UI state ──
  const [showResume, setShowResume] = useState(hasSavedSession);
  const [phase, setPhase] = useState(hasSavedSession ? "location" : (saved?.phase || "location"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);

  // ── Phase 1: Location ──
  const [locations, setLocations] = useState(saved?.locations || []);
  const [selectedLocation, setSelectedLocation] = useState(saved?.selectedLocation || null);

  // ── Phase 2: Source bin ──
  const [sourceBin, setSourceBin] = useState(saved?.sourceBin || null); // { bin_id, bin_number }
  const [binContents, setBinContents] = useState(saved?.binContents || []);

  // ── Phase 3: Items to move ──
  const [moveItems, setMoveItems] = useState(saved?.moveItems || {}); // item_id -> qty to move
  const [scanHistory, setScanHistory] = useState(saved?.scanHistory || []); // for undo

  // ── Phase 4: Destination bin ──
  const [destBin, setDestBin] = useState(saved?.destBin || null); // { bin_id, bin_number }

  // ── Refs ──
  const scanRef = useRef(null);
  const { openDrawer, DrawerComponent } = useItemDetailDrawer(scanRef);

  // ── Inline qty editor ──
  const [editingItemId, setEditingItemId] = useState(null);
  const [editQty, setEditQty] = useState("");

  // ── Click-anywhere re-focus ──
  useScanRefocus(scanRef, phase === "scan-source" || phase === "scan-items" || phase === "scan-dest");

  // ═══════════════════════════════════════════════════════════
  // SESSION PERSISTENCE
  // ═══════════════════════════════════════════════════════════
  useEffect(() => {
    if (phase === "location" && locations.length === 0) return;
    if (submitResult?.success) return;
    saveSession(SESSION_KEY, {
      phase, locations, selectedLocation, sourceBin, binContents,
      moveItems, scanHistory, destBin,
    });
  }, [phase, locations, selectedLocation, sourceBin, binContents,
    moveItems, scanHistory, destBin, submitResult]);

  // ── Resume handler ──
  const handleResume = () => {
    setShowResume(false);
    if (saved) {
      setPhase(saved.phase || "location");
      setLocations(saved.locations || []);
      setSelectedLocation(saved.selectedLocation || null);
      setSourceBin(saved.sourceBin || null);
      setBinContents(saved.binContents || []);
      setMoveItems(saved.moveItems || {});
      setScanHistory(saved.scanHistory || []);
      setDestBin(saved.destBin || null);
    }
  };
  const handleFresh = () => {
    setShowResume(false);
    clearSession(SESSION_KEY);
    setPhase("location");
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 — LOAD LOCATIONS
  // ═══════════════════════════════════════════════════════════
  useEffect(() => {
    if (locations.length > 0) return;
    (async () => {
      setLoading(true);
      try {
        const rows = await suiteql(`SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name`);
        setLocations(rows);
      } catch (e) { setError(`Failed to load locations: ${e.message}`); }
      finally { setLoading(false); }
    })();
  }, []);

  const selectLocation = (loc) => {
    setSelectedLocation(loc);
    setPhase("scan-source");
  };

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — SCAN SOURCE BIN
  // ═══════════════════════════════════════════════════════════
  const handleSourceBinScan = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed || !selectedLocation) return;
    setError(null);
    setLoading(true);
    try {
      // Load bin contents (also validates the bin exists at this location)
      const contents = await suiteql(`
        SELECT
          ib.item AS item_id,
          item.itemid AS sku,
          item.displayname AS item_name,
          item.upccode AS upc,
          ib.quantityonhand AS qty_in_bin,
          ib.quantityavailable AS qty_available,
          ib.binnumber AS bin_id,
          BUILTIN.DF(ib.binnumber) AS bin_number
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        WHERE BUILTIN.DF(ib.binnumber) = '${trimmed.replace(/'/g, "''")}'
          AND ib.location = ${selectedLocation.id}
          AND ib.quantityonhand > 0
        ORDER BY item.itemid
      `);

      if (contents.length === 0) {
        beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
        setError("Bin is empty or not found at this location");
        setLoading(false);
        return;
      }

      const bin = { bin_id: contents[0].bin_id, bin_number: contents[0].bin_number };
      setSourceBin(bin);
      setBinContents(contents);
      setMoveItems({});
      setScanHistory([]);
      setDestBin(null);
      beepBin(); setFlash("bin"); setTimeout(() => setFlash(null), 400);
      setPhase("scan-items");
    } catch (e) {
      beepWarn(); setError(`Bin lookup failed: ${e.message}`);
    } finally { setLoading(false); }
  }, [selectedLocation]);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 — SCAN ITEMS TO MOVE
  // ═══════════════════════════════════════════════════════════
  const upcLookup = useMemo(() => {
    const m = {};
    binContents.forEach(item => {
      if (item.upc) m[item.upc] = item;
    });
    return m;
  }, [binContents]);

  const skuLookup = useMemo(() => {
    const m = {};
    binContents.forEach(item => {
      if (item.sku) m[item.sku.toUpperCase()] = item;
    });
    return m;
  }, [binContents]);

  const handleItemScan = useCallback((val) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setError(null);

    // Match by UPC first, then by SKU
    const item = upcLookup[trimmed] || skuLookup[trimmed.toUpperCase()];
    if (!item) {
      beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
      setError(`Item not in ${sourceBin?.bin_number}`);
      return;
    }

    const currentQty = moveItems[item.item_id] || 0;
    const maxQty = Number(item.qty_in_bin) || 0;
    if (currentQty >= maxQty) {
      beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
      setError(`Only ${maxQty} available in this bin`);
      return;
    }

    setMoveItems(p => ({ ...p, [item.item_id]: currentQty + 1 }));
    setScanHistory(p => [...p, item.item_id]);
    beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
  }, [upcLookup, skuLookup, moveItems, sourceBin]);

  const undoLast = useCallback(() => {
    if (scanHistory.length === 0) return;
    const lastItemId = scanHistory[scanHistory.length - 1];
    setScanHistory(p => p.slice(0, -1));
    setMoveItems(p => {
      const next = { ...p };
      const qty = (next[lastItemId] || 0) - 1;
      if (qty <= 0) delete next[lastItemId];
      else next[lastItemId] = qty;
      return next;
    });
  }, [scanHistory]);

  const setItemQty = useCallback((itemId, qty) => {
    const item = binContents.find(i => i.item_id === itemId);
    if (!item) return;
    const maxQty = Number(item.qty_in_bin) || 0;
    const clamped = Math.max(0, Math.min(qty, maxQty));
    setMoveItems(p => {
      const next = { ...p };
      if (clamped <= 0) delete next[itemId];
      else next[itemId] = clamped;
      return next;
    });
    setEditingItemId(null);
    setEditQty("");
  }, [binContents]);

  const totalMoveItems = Object.keys(moveItems).length;
  const totalMoveScans = Object.values(moveItems).reduce((s, q) => s + q, 0);

  // ═══════════════════════════════════════════════════════════
  // PHASE 4 — SCAN DESTINATION BIN
  // ═══════════════════════════════════════════════════════════
  const handleDestBinScan = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed || !selectedLocation) return;
    setError(null);
    setLoading(true);
    try {
      // Can't be same as source
      if (trimmed.toUpperCase() === sourceBin?.bin_number?.toUpperCase()) {
        beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
        setError("Destination must be different from source");
        setLoading(false);
        return;
      }

      // Validate bin exists at this location via Bin table (works for empty bins too)
      const bins = await suiteql(`
        SELECT id AS bin_id, binnumber AS bin_number
        FROM Bin
        WHERE binnumber = '${trimmed.replace(/'/g, "''")}'
          AND location = ${selectedLocation.id}
      `);
      if (bins.length === 0) {
        beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
        setError(`Bin not found at ${selectedLocation.name}`);
        setLoading(false);
        return;
      }

      setDestBin(bins[0]);
      beepBin(); setFlash("bin"); setTimeout(() => setFlash(null), 400);
      setPhase("review");
    } catch (e) {
      beepWarn(); setError(`Bin lookup failed: ${e.message}`);
    } finally { setLoading(false); }
  }, [selectedLocation, sourceBin]);

  // ═══════════════════════════════════════════════════════════
  // PHASE 5 — SUBMIT
  // ═══════════════════════════════════════════════════════════
  const movingItemsList = useMemo(() => {
    return binContents
      .filter(item => (moveItems[item.item_id] || 0) > 0)
      .map(item => ({ ...item, move_qty: moveItems[item.item_id] }));
  }, [binContents, moveItems]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Create bin transfer record
      const inventoryLines = movingItemsList.map(item => ({
        item: { id: String(item.item_id) },
        quantity: Number(item.move_qty),
        inventoryDetail: {
          inventoryAssignment: {
            items: [{
              binNumber: { id: String(sourceBin.bin_id) },
              toBinNumber: { id: String(destBin.bin_id) },
              quantity: Number(item.move_qty),
            }],
          },
        },
      }));

      await nsRecord("POST", "bintransfer", {
        subsidiary: { id: "2" },
        location: { id: String(selectedLocation.id) },
        memo: `${sourceBin.bin_number} to ${destBin.bin_number}`.slice(0, 40),
        inventory: { items: inventoryLines },
      });

      clearSession(SESSION_KEY);
      setSubmitResult({ success: true });
      try {
        logActivity({
          module: "bin-transfer",
          action: "bin-transfer-completed",
          status: "success",
          sourceDocument: `${sourceBin.bin_number} → ${destBin.bin_number}`,
          details: `${selectedLocation.name}: ${movingItemsList.length} items, ${totalMoveScans} units`,
          items: movingItemsList.map(i => ({ sku: i.sku, name: i.item_name, qty: i.move_qty })),
        });
      } catch (_) { }
    } catch (e) {
      const msg = e.message || "Unknown error";
      setError(`Transfer failed: ${msg}`);
      setSubmitResult({ success: false, error: msg });
      try {
        logActivity({
          module: "bin-transfer",
          action: "bin-transfer-failed",
          status: "error",
          sourceDocument: `${sourceBin?.bin_number} → ${destBin?.bin_number}`,
          details: `${selectedLocation?.name}: ${movingItemsList.length} items`,
          items: movingItemsList.map(i => ({ sku: i.sku, name: i.item_name, qty: i.move_qty })),
          error: e.message,
        });
      } catch (_) { }
    } finally { setSubmitting(false); }
  }, [submitting, movingItemsList, sourceBin, destBin, selectedLocation, totalMoveScans]);

  const startNewTransfer = () => {
    clearSession(SESSION_KEY);
    setSourceBin(null);
    setBinContents([]);
    setMoveItems({});
    setScanHistory([]);
    setDestBin(null);
    setSubmitResult(null);
    setError(null);
    setPhase("scan-source");
  };

  // ═══════════════════════════════════════════════════════════
  // AUTO-FOCUS
  // ═══════════════════════════════════════════════════════════
  useEffect(() => {
    if (phase === "scan-source" || phase === "scan-items" || phase === "scan-dest") {
      const t = setTimeout(() => scanRef.current?.focus(), 150);
      return () => clearTimeout(t);
    }
  }, [phase]);

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  // ── Resume prompt ──
  if (showResume) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <ResumePrompt onResume={handleResume} onFresh={handleFresh} moduleName="Bin Transfer" />
      </div>
    );
  }

  // ── Location badge (shown in phases 2-5) ──
  const LocationBadge = () => selectedLocation ? (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 10px", borderRadius: 20,
      background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`,
      fontSize: 11, color: ACCENT, ...mono, fontWeight: 600,
    }}>
      📍 {selectedLocation.name}
    </div>
  ) : null;

  // ── Item row for bin contents ──
  const ItemRow = ({ item, interactive = false }) => {
    const moveQty = moveItems[item.item_id] || 0;
    const isEditing = editingItemId === item.item_id;
    const maxQty = Number(item.qty_in_bin) || 0;

    return (
      <div
        style={{
          padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
          background: moveQty > 0 ? "rgba(20,184,166,0.06)" : "transparent",
          transition: "background 0.15s",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div
            style={{ flex: 1, cursor: "pointer" }}
            onClick={() => openDrawer(item.item_id)}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", ...mono }}>{item.sku}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{item.item_name}</div>
            {item.upc && <div style={{ fontSize: 11, color: "#475569", marginTop: 1, ...mono }}>{item.upc}</div>}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", ...mono }}>{maxQty}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>in bin</div>
          </div>
        </div>

        {/* Interactive: show move qty & inline editor */}
        {interactive && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            {moveQty > 0 && !isEditing && (
              <div style={{
                fontSize: 12, fontWeight: 600, color: ACCENT, ...mono,
                padding: "2px 8px", borderRadius: 4,
                background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`,
              }}>
                Moving: {moveQty} of {maxQty}
              </div>
            )}
            {isEditing ? (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => {
                    const q = Math.max(0, (parseInt(editQty) || 0) - 1);
                    setEditQty(String(q));
                  }}
                  style={{ ...S.btnSm, width: 36, minHeight: 36, padding: 0, textAlign: "center", fontSize: 18 }}
                >−</button>
                <input
                  type="number"
                  value={editQty}
                  onChange={e => setEditQty(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") setItemQty(item.item_id, parseInt(editQty) || 0); }}
                  style={{
                    ...S.inp, width: 60, minHeight: 36, padding: "6px 8px",
                    textAlign: "center", fontSize: 14, ...mono,
                  }}
                  autoFocus
                />
                <button
                  onClick={() => {
                    const q = Math.min(maxQty, (parseInt(editQty) || 0) + 1);
                    setEditQty(String(q));
                  }}
                  style={{ ...S.btnSm, width: 36, minHeight: 36, padding: 0, textAlign: "center", fontSize: 18 }}
                >+</button>
                <button
                  onClick={() => setItemQty(item.item_id, parseInt(editQty) || 0)}
                  style={{ ...S.btnSm, background: ACCENT, color: "#fff", border: "none", padding: "6px 12px" }}
                >OK</button>
                <button
                  onClick={() => { setEditingItemId(null); setEditQty(""); }}
                  style={{ ...S.btnSm, padding: "6px 10px" }}
                >✕</button>
              </div>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingItemId(item.item_id);
                  setEditQty(String(moveQty || ""));
                }}
                style={{ ...S.btnSm, fontSize: 11, padding: "4px 10px" }}
              >
                {moveQty > 0 ? "Edit Qty" : "Set Qty"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* ════════════ HEADER ════════════ */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>Bin Transfer</span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      <div style={{ padding: "16px 16px 120px" }}>

        {/* ════════════ PHASE 1 — SELECT LOCATION ════════════ */}
        {phase === "location" && (
          <div style={fadeIn}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Select Location</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Choose the warehouse location for this transfer</div>
            </div>

            {loading && <PulsingDot color={ACCENT} label="Loading locations..." />}
            {error && <div style={S.err}>{error}</div>}

            {!loading && locations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {locations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => selectLocation(loc)}
                    style={{
                      ...S.card, cursor: "pointer", padding: "14px 16px",
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      border: `1px solid ${ACCENT}25`, background: `${ACCENT}06`,
                      transition: "all 0.15s", touchAction: "manipulation",
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{loc.name}</span>
                    <span style={{ color: "#475569", fontSize: 16 }}>›</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════ PHASE 2 — SCAN SOURCE BIN ════════════ */}
        {phase === "scan-source" && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 12 }}><LocationBadge /></div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Scan Source Bin</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Scan the bin you want to pull items from</div>
            </div>

            {error && <div style={S.err}>{error}</div>}
            {loading && <PulsingDot color={ACCENT} label="Looking up bin..." />}

            <ScanInput
              onScan={handleSourceBinScan}
              placeholder="Scan bin to pull from..."
              flash={flash}
              inputRef={scanRef}
            />

            <div style={{ marginTop: 16 }}>
              <button
                onClick={() => { setSelectedLocation(null); setPhase("location"); }}
                style={S.btnSec}
              >Change Location</button>
            </div>
          </div>
        )}

        {/* ════════════ PHASE 3 — SCAN ITEMS TO MOVE ════════════ */}
        {phase === "scan-items" && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <LocationBadge />
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "3px 10px", borderRadius: 20,
                background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.25)",
                fontSize: 11, color: "#60a5fa", ...mono, fontWeight: 600,
              }}>
                From: {sourceBin?.bin_number}
              </div>
            </div>

            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
              Moving from {sourceBin?.bin_number}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
              {binContents.length} item{binContents.length !== 1 ? "s" : ""} in this bin
            </div>

            {error && <div style={S.err}>{error}</div>}

            <ScanInput
              onScan={handleItemScan}
              placeholder="Scan items to move..."
              flash={flash}
              inputRef={scanRef}
            />

            {/* Item list */}
            <div style={{
              ...S.card, padding: 0, marginTop: 12, maxHeight: "40vh",
              overflowY: "auto", WebkitOverflowScrolling: "touch",
            }}>
              {binContents.map(item => (
                <ItemRow key={item.item_id} item={item} interactive />
              ))}
            </div>

            {/* Running summary */}
            <div style={{
              marginTop: 12, padding: "10px 14px", borderRadius: 8,
              background: totalMoveItems > 0 ? `${ACCENT}10` : "rgba(255,255,255,0.03)",
              border: `1px solid ${totalMoveItems > 0 ? `${ACCENT}30` : "rgba(255,255,255,0.06)"}`,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span style={{ fontSize: 13, color: totalMoveItems > 0 ? ACCENT : "#64748b", fontWeight: 600 }}>
                {totalMoveItems > 0
                  ? `${totalMoveItems} item${totalMoveItems !== 1 ? "s" : ""} to move (${totalMoveScans} unit${totalMoveScans !== 1 ? "s" : ""})`
                  : "Scan items to select them"}
              </span>
              {scanHistory.length > 0 && (
                <button onClick={undoLast} style={{ ...S.btnSm, fontSize: 11, padding: "4px 10px" }}>
                  Undo Last
                </button>
              )}
            </div>

            {/* Actions */}
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setSourceBin(null);
                  setBinContents([]);
                  setMoveItems({});
                  setScanHistory([]);
                  setPhase("scan-source");
                }}
                style={{ ...S.btnSec, flex: 1 }}
              >Change Source Bin</button>
              <button
                onClick={() => setPhase("scan-dest")}
                disabled={totalMoveItems === 0}
                style={{
                  ...S.btn, flex: 1,
                  background: totalMoveItems > 0 ? ACCENT : "#334155",
                  opacity: totalMoveItems > 0 ? 1 : 0.5,
                }}
              >Select Destination</button>
            </div>
          </div>
        )}

        {/* ════════════ PHASE 4 — SCAN DESTINATION BIN ════════════ */}
        {phase === "scan-dest" && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <LocationBadge />
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "3px 10px", borderRadius: 20,
                background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.25)",
                fontSize: 11, color: "#60a5fa", ...mono, fontWeight: 600,
              }}>
                From: {sourceBin?.bin_number}
              </div>
            </div>

            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
              Moving {totalMoveScans} unit{totalMoveScans !== 1 ? "s" : ""} from {sourceBin?.bin_number}
            </div>

            {/* Summary of what's being moved */}
            <div style={{ ...S.card, padding: 0, marginBottom: 16, maxHeight: "25vh", overflowY: "auto" }}>
              {movingItemsList.map(item => (
                <div key={item.item_id} style={{
                  padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", ...mono }}>{item.sku}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{item.item_name}</div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: ACCENT, ...mono }}>×{item.move_qty}</div>
                </div>
              ))}
            </div>

            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Scan Destination Bin</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Where should these items go?</div>
            </div>

            {error && <div style={S.err}>{error}</div>}
            {loading && <PulsingDot color={ACCENT} label="Looking up bin..." />}

            <ScanInput
              onScan={handleDestBinScan}
              placeholder="Scan bin to move to..."
              flash={flash}
              inputRef={scanRef}
            />

            <div style={{ marginTop: 16 }}>
              <button onClick={() => setPhase("scan-items")} style={S.btnSec}>← Back to Items</button>
            </div>
          </div>
        )}

        {/* ════════════ PHASE 5 — REVIEW & SUBMIT ════════════ */}
        {phase === "review" && !submitResult?.success && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 16 }}><LocationBadge /></div>

            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, textAlign: "center" }}>
              Review Transfer
            </div>

            {/* From / To card */}
            <div style={{ ...S.card, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={S.lbl}>From</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0", ...mono }}>{sourceBin?.bin_number}</div>
                </div>
                <div style={{ fontSize: 24, color: "#475569", alignSelf: "center" }}>→</div>
                <div style={{ textAlign: "right" }}>
                  <div style={S.lbl}>To</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: ACCENT, ...mono }}>{destBin?.bin_number}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>
                at {selectedLocation?.name}
              </div>
            </div>

            {/* Items */}
            <div style={{ ...S.card, padding: 0, marginBottom: 12, maxHeight: "35vh", overflowY: "auto" }}>
              {movingItemsList.map(item => (
                <div key={item.item_id} style={{
                  padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", ...mono }}>{item.sku}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{item.item_name}</div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: ACCENT, ...mono }}>×{item.move_qty}</div>
                </div>
              ))}
            </div>

            <div style={{
              textAlign: "center", fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16,
            }}>
              Total: {totalMoveItems} item{totalMoveItems !== 1 ? "s" : ""}, {totalMoveScans} unit{totalMoveScans !== 1 ? "s" : ""}
            </div>

            {error && <div style={S.err}>{error}</div>}

            {/* Actions */}
            <button
              onClick={handleSubmit}
              disabled={submitting}
              style={{
                ...S.btn, background: "#22c55e", marginBottom: 8,
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Submitting..." : "Confirm Transfer"}
            </button>

            {submitResult?.success === false && (
              <button
                onClick={handleSubmit}
                style={{ ...S.btn, background: "#f59e0b", marginBottom: 8 }}
              >Retry</button>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setDestBin(null); setPhase("scan-dest"); }} style={{ ...S.btnSec, flex: 1 }}>
                ← Change Dest
              </button>
              <button
                onClick={() => {
                  setSourceBin(null); setBinContents([]); setMoveItems({});
                  setScanHistory([]); setDestBin(null); setError(null);
                  setSubmitResult(null); setPhase("scan-source");
                }}
                style={{ ...S.btnSec, flex: 1, color: "#f87171", borderColor: "rgba(239,68,68,0.2)" }}
              >Cancel</button>
            </div>
          </div>
        )}

        {/* ════════════ SUCCESS ════════════ */}
        {submitResult?.success && (
          <div style={{ ...fadeIn, textAlign: "center", padding: "40px 0" }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%", margin: "0 auto 16px",
              background: "rgba(34,197,94,0.15)", border: "2px solid rgba(34,197,94,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28,
            }}>✓</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>
              Bin Transfer Complete
            </div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 24 }}>
              {totalMoveScans} unit{totalMoveScans !== 1 ? "s" : ""} moved from {sourceBin?.bin_number} to {destBin?.bin_number}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={startNewTransfer} style={{ ...S.btn, flex: 1, background: ACCENT }}>
                New Transfer
              </button>
              <button onClick={onBack} style={{ ...S.btnSec, flex: 1 }}>Home</button>
            </div>
          </div>
        )}
      </div>

      {DrawerComponent}
    </div>
  );
}
