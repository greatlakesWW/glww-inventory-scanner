import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  suiteql,
  beepOk, beepWarn, beepBin,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo,
  loadSession, saveSession, clearSession,
  ScanInput, useScanRefocus, PulsingDot, ResumePrompt,
} from "../shared";
import { useItemDetailDrawer } from "../components/ItemDetail";
import { logActivity } from "../activityLog";

// ═══════════════════════════════════════════════════════════
const SESSION_KEY = "glww_create_inventory";
const ACCENT = "#10b981"; // emerald

// ═══════════════════════════════════════════════════════════
// CREATE INVENTORY MODULE
// ═══════════════════════════════════════════════════════════
export default function CreateInventory({ onBack }) {
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

  // ── Phase 2: Bin ──
  const [destBin, setDestBin] = useState(saved?.destBin || null); // { bin_id, bin_number }

  // ── Phase 3: Items ──
  const [items, setItems] = useState(saved?.items || []); // [{ internalid, sku, item_name, upc, qty }]
  const [editingIdx, setEditingIdx] = useState(null);
  const [editQty, setEditQty] = useState("");

  // ── Refs ──
  const scanRef = useRef(null);
  const { openDrawer, DrawerComponent } = useItemDetailDrawer(scanRef);

  // ── Click-anywhere re-focus ──
  useScanRefocus(scanRef, phase === "scan-bin" || phase === "scan-items");

  // ═══════════════════════════════════════════════════════════
  // SESSION PERSISTENCE
  // ═══════════════════════════════════════════════════════════
  useEffect(() => {
    if (phase === "location" && locations.length === 0) return;
    if (submitResult?.success) return;
    saveSession(SESSION_KEY, {
      phase, locations, selectedLocation, destBin, items,
    });
  }, [phase, locations, selectedLocation, destBin, items, submitResult]);

  const handleResume = () => {
    setShowResume(false);
    if (saved) {
      setPhase(saved.phase || "location");
      setLocations(saved.locations || []);
      setSelectedLocation(saved.selectedLocation || null);
      setDestBin(saved.destBin || null);
      setItems(saved.items || []);
    }
  };
  const handleFresh = () => { setShowResume(false); clearSession(SESSION_KEY); setPhase("location"); };

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

  const selectLocation = (loc) => { setSelectedLocation(loc); setPhase("scan-bin"); };

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 — SCAN BIN
  // ═══════════════════════════════════════════════════════════
  const handleBinScan = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed || !selectedLocation) return;
    setError(null);
    setLoading(true);
    try {
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
      setPhase("scan-items");
    } catch (e) {
      beepWarn(); setError(`Bin lookup failed: ${e.message}`);
    } finally { setLoading(false); }
  }, [selectedLocation]);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 — SCAN ITEMS
  // ═══════════════════════════════════════════════════════════
  const handleItemScan = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setError(null);

    // Check if already in list
    const existing = items.find(i => i.upc === trimmed || i.sku?.toUpperCase() === trimmed.toUpperCase());
    if (existing) {
      // Increment qty
      setItems(p => p.map(i =>
        i.internalid === existing.internalid ? { ...i, qty: i.qty + 1 } : i
      ));
      beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
      return;
    }

    // Look up item in NetSuite
    try {
      const escaped = trimmed.replace(/'/g, "''");
      const rows = await suiteql(`
        SELECT item.id AS internalid, item.itemid AS sku,
               item.displayname AS item_name, item.upccode AS upc
        FROM item
        WHERE (item.upccode = '${escaped}' OR item.itemid = '${escaped}')
          AND item.isinactive = 'F'
      `);
      if (rows.length === 0) {
        beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
        setError(`Item not found: "${trimmed}"`);
        return;
      }
      const found = rows[0];
      // Check if already added by internalid (different scan value)
      const alreadyAdded = items.find(i => i.internalid === found.internalid);
      if (alreadyAdded) {
        setItems(p => p.map(i =>
          i.internalid === found.internalid ? { ...i, qty: i.qty + 1 } : i
        ));
      } else {
        setItems(p => [...p, { ...found, qty: 1 }]);
      }
      beepOk(); setFlash("ok"); setTimeout(() => setFlash(null), 400);
    } catch (e) {
      beepWarn(); setFlash("warn"); setTimeout(() => setFlash(null), 400);
      setError(`Lookup failed: ${e.message}`);
    }
  }, [items]);

  const removeItem = (idx) => setItems(p => p.filter((_, i) => i !== idx));

  const setItemQty = (idx, qty) => {
    const clamped = Math.max(1, qty);
    setItems(p => p.map((item, i) => i === idx ? { ...item, qty: clamped } : item));
    setEditingIdx(null);
    setEditQty("");
  };

  const totalQty = items.reduce((s, i) => s + i.qty, 0);

  // ═══════════════════════════════════════════════════════════
  // PHASE 4 — SUBMIT
  // ═══════════════════════════════════════════════════════════
  const handleSubmit = useCallback(async () => {
    if (submitting || items.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: selectedLocation.id,
          locationName: selectedLocation.name,
          memo: `Add inventory: ${destBin.bin_number}`.slice(0, 40),
          items: items.map(i => ({
            internalid: i.internalid,
            diff: i.qty,
            bin_id: String(destBin.bin_id),
            bin_name: destBin.bin_number,
          })),
          binMap: { [destBin.bin_number]: String(destBin.bin_id) },
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || data.details?.[0] || `API error ${resp.status}`);
      }

      clearSession(SESSION_KEY);
      setSubmitResult({ success: true, recordId: data.recordId });
      try {
        logActivity({
          module: "create-inventory",
          action: "inventory-created",
          status: "success",
          sourceDocument: `${destBin.bin_number} @ ${selectedLocation.name}`,
          netsuiteRecord: data.recordId ? `Adj #${data.recordId}` : undefined,
          details: `${items.length} items, ${totalQty} units into ${destBin.bin_number}`,
          items: items.map(i => ({ sku: i.sku, name: i.item_name, qty: i.qty })),
        });
      } catch (_) { }
    } catch (e) {
      setError(`Submit failed: ${e.message}`);
      setSubmitResult({ success: false, error: e.message });
      try {
        logActivity({
          module: "create-inventory",
          action: "inventory-create-failed",
          status: "error",
          sourceDocument: `${destBin?.bin_number} @ ${selectedLocation?.name}`,
          details: `${items.length} items`,
          items: items.map(i => ({ sku: i.sku, name: i.item_name, qty: i.qty })),
          error: e.message,
        });
      } catch (_) { }
    } finally { setSubmitting(false); }
  }, [submitting, items, selectedLocation, destBin, totalQty]);

  const startNew = () => {
    clearSession(SESSION_KEY);
    setDestBin(null);
    setItems([]);
    setSubmitResult(null);
    setError(null);
    setPhase("scan-bin");
  };

  // ═══════════════════════════════════════════════════════════
  // AUTO-FOCUS
  // ═══════════════════════════════════════════════════════════
  useEffect(() => {
    if (phase === "scan-bin" || phase === "scan-items") {
      const t = setTimeout(() => scanRef.current?.focus(), 150);
      return () => clearTimeout(t);
    }
  }, [phase]);

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  if (showResume) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <ResumePrompt onResume={handleResume} onFresh={handleFresh} moduleName="Create Inventory" />
      </div>
    );
  }

  const LocationBadge = () => selectedLocation ? (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 10px", borderRadius: 20,
      background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`,
      fontSize: 11, color: ACCENT, ...mono, fontWeight: 600,
    }}>
      {selectedLocation.name}
    </div>
  ) : null;

  const BinBadge = () => destBin ? (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "3px 10px", borderRadius: 20,
      background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.25)",
      fontSize: 11, color: "#60a5fa", ...mono, fontWeight: 600,
    }}>
      Bin: {destBin.bin_number}
    </div>
  ) : null;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* ════════════ HEADER ════════════ */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>Create Inventory</span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      <div style={{ padding: "16px 16px 120px" }}>

        {/* ════════════ PHASE 1 — SELECT LOCATION ════════════ */}
        {phase === "location" && (
          <div style={fadeIn}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Select Location</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Choose where to add inventory</div>
            </div>
            {loading && <PulsingDot color={ACCENT} label="Loading locations..." />}
            {error && <div style={S.err}>{error}</div>}
            {!loading && locations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {locations.map(loc => (
                  <button key={loc.id} onClick={() => selectLocation(loc)} style={{
                    ...S.card, cursor: "pointer", padding: "14px 16px",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    border: `1px solid ${ACCENT}25`, background: `${ACCENT}06`,
                    transition: "all 0.15s", touchAction: "manipulation",
                  }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{loc.name}</span>
                    <span style={{ color: "#475569", fontSize: 16 }}>›</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════ PHASE 2 — SCAN BIN ════════════ */}
        {phase === "scan-bin" && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 12 }}><LocationBadge /></div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Scan Destination Bin</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Which bin should receive the items?</div>
            </div>
            {error && <div style={S.err}>{error}</div>}
            {loading && <PulsingDot color={ACCENT} label="Looking up bin..." />}
            <ScanInput onScan={handleBinScan} placeholder="Scan bin..." flash={flash} inputRef={scanRef} />
            <div style={{ marginTop: 16 }}>
              <button onClick={() => { setSelectedLocation(null); setPhase("location"); }} style={S.btnSec}>Change Location</button>
            </div>
          </div>
        )}

        {/* ════════════ PHASE 3 — SCAN ITEMS ════════════ */}
        {phase === "scan-items" && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <LocationBadge /><BinBadge />
            </div>

            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Scan Items to Add</div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
              Scan UPC or type SKU. Each scan adds 1 qty — tap row to edit.
            </div>

            {error && <div style={S.err}>{error}</div>}

            <ScanInput onScan={handleItemScan} placeholder="Scan item UPC or SKU..." flash={flash} inputRef={scanRef} />

            {/* Item list */}
            {items.length > 0 && (
              <div style={{ ...S.card, padding: 0, marginTop: 12, maxHeight: "40vh", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
                {items.map((item, idx) => {
                  const isEditing = editingIdx === idx;
                  return (
                    <div key={item.internalid} style={{
                      padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
                      background: `${ACCENT}06`,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1, cursor: "pointer" }} onClick={() => openDrawer(item.internalid)}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", ...mono }}>{item.sku}</div>
                          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{item.item_name}</div>
                          {item.upc && <div style={{ fontSize: 11, color: "#475569", marginTop: 1, ...mono }}>{item.upc}</div>}
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 18, fontWeight: 700, color: ACCENT, ...mono }}>×{item.qty}</div>
                          <button onClick={(e) => { e.stopPropagation(); removeItem(idx); }} style={{
                            ...S.btnSm, width: 28, minHeight: 28, padding: 0, textAlign: "center",
                            fontSize: 14, color: "#ef4444", borderColor: "rgba(239,68,68,0.2)",
                          }}>✕</button>
                        </div>
                      </div>
                      {/* Qty editor */}
                      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 4 }}>
                        {isEditing ? (
                          <>
                            <button onClick={() => setEditQty(String(Math.max(1, (parseInt(editQty) || 0) - 1)))} style={{ ...S.btnSm, width: 36, minHeight: 36, padding: 0, textAlign: "center", fontSize: 18 }}>−</button>
                            <input
                              type="number" value={editQty} autoFocus
                              onChange={e => setEditQty(e.target.value)}
                              onKeyDown={e => { if (e.key === "Enter") setItemQty(idx, parseInt(editQty) || 1); }}
                              onClick={e => e.stopPropagation()}
                              style={{ ...S.inp, width: 64, minHeight: 36, padding: "6px 8px", textAlign: "center", fontSize: 16, ...mono }}
                            />
                            <button onClick={() => setEditQty(String((parseInt(editQty) || 0) + 1))} style={{ ...S.btnSm, width: 36, minHeight: 36, padding: 0, textAlign: "center", fontSize: 18 }}>+</button>
                            <button onClick={() => setItemQty(idx, parseInt(editQty) || 1)} style={{ ...S.btnSm, background: ACCENT, color: "#fff", border: "none", padding: "6px 12px" }}>OK</button>
                            <button onClick={() => { setEditingIdx(null); setEditQty(""); }} style={{ ...S.btnSm, padding: "6px 10px" }}>✕</button>
                          </>
                        ) : (
                          <button onClick={(e) => { e.stopPropagation(); setEditingIdx(idx); setEditQty(String(item.qty)); }} style={{ ...S.btnSm, fontSize: 11, padding: "4px 10px" }}>Edit Qty</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Summary */}
            <div style={{
              marginTop: 12, padding: "10px 14px", borderRadius: 8,
              background: items.length > 0 ? `${ACCENT}10` : "rgba(255,255,255,0.03)",
              border: `1px solid ${items.length > 0 ? `${ACCENT}30` : "rgba(255,255,255,0.06)"}`,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span style={{ fontSize: 13, color: items.length > 0 ? ACCENT : "#64748b", fontWeight: 600 }}>
                {items.length > 0 ? `${items.length} item${items.length !== 1 ? "s" : ""}, ${totalQty} unit${totalQty !== 1 ? "s" : ""}` : "Scan items to add them"}
              </span>
            </div>

            {/* Actions */}
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button onClick={() => { setDestBin(null); setItems([]); setPhase("scan-bin"); }} style={{ ...S.btnSec, flex: 1 }}>Change Bin</button>
              <button
                onClick={() => setPhase("review")}
                disabled={items.length === 0}
                style={{ ...S.btn, flex: 1, background: items.length > 0 ? ACCENT : "#334155", opacity: items.length > 0 ? 1 : 0.5 }}
              >Review</button>
            </div>
          </div>
        )}

        {/* ════════════ PHASE 4 — REVIEW & SUBMIT ════════════ */}
        {phase === "review" && !submitResult?.success && (
          <div style={fadeIn}>
            <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}><LocationBadge /><BinBadge /></div>

            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16, textAlign: "center" }}>Review</div>

            <div style={{ ...S.card, marginBottom: 12 }}>
              <div style={S.lbl}>Adding to</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: ACCENT, ...mono }}>{destBin?.bin_number}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>at {selectedLocation?.name}</div>
            </div>

            <div style={{ ...S.card, padding: 0, marginBottom: 12, maxHeight: "35vh", overflowY: "auto" }}>
              {items.map(item => (
                <div key={item.internalid} style={{
                  padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0", ...mono }}>{item.sku}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{item.item_name}</div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: ACCENT, ...mono }}>×{item.qty}</div>
                </div>
              ))}
            </div>

            <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>
              Total: {items.length} item{items.length !== 1 ? "s" : ""}, {totalQty} unit{totalQty !== 1 ? "s" : ""}
            </div>

            {error && <div style={S.err}>{error}</div>}

            <button onClick={handleSubmit} disabled={submitting} style={{
              ...S.btn, background: "#22c55e", marginBottom: 8, opacity: submitting ? 0.6 : 1,
            }}>
              {submitting ? "Submitting..." : "Confirm"}
            </button>

            {submitResult?.success === false && (
              <button onClick={handleSubmit} style={{ ...S.btn, background: "#f59e0b", marginBottom: 8 }}>Retry</button>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setPhase("scan-items")} style={{ ...S.btnSec, flex: 1 }}>← Edit Items</button>
              <button onClick={() => {
                setDestBin(null); setItems([]); setError(null);
                setSubmitResult(null); setPhase("scan-bin");
              }} style={{ ...S.btnSec, flex: 1, color: "#f87171", borderColor: "rgba(239,68,68,0.2)" }}>Cancel</button>
            </div>
          </div>
        )}

        {/* ════════════ SUCCESS ════════════ */}
        {submitResult?.success && (
          <div style={{ ...fadeIn, textAlign: "center", padding: "40px 0" }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%", margin: "0 auto 16px",
              background: "rgba(34,197,94,0.15)", border: "2px solid rgba(34,197,94,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
            }}>✓</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>Inventory Created</div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 24 }}>
              {totalQty} unit{totalQty !== 1 ? "s" : ""} added to {destBin?.bin_number} at {selectedLocation?.name}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={startNew} style={{ ...S.btn, flex: 1, background: ACCENT }}>Add More</button>
              <button onClick={onBack} style={{ ...S.btnSec, flex: 1 }}>Home</button>
            </div>
          </div>
        )}
      </div>

      {DrawerComponent}
    </div>
  );
}
