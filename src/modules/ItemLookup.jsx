import { useState, useRef, useCallback } from "react";
import {
  suiteql, beepOk, beepWarn,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo, PulsingDot, ScanInput,
} from "../shared";
import { logActivity } from "../activityLog";

// ═══════════════════════════════════════════════════════════
// ITEM LOOKUP MODULE — quick inventory check tool
// ═══════════════════════════════════════════════════════════

const LOCATION_IDS = { salesFloor: 1, backroom: 2, warehouse: 3 }; // adjust if needed

export default function ItemLookup({ onBack }) {
  const [item, setItem] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [stockLevels, setStockLevels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [invLoading, setInvLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [history, setHistory] = useState([]);
  const scanRef = useRef(null);

  const doFlash = (type) => { setFlash(type); setTimeout(() => setFlash(null), 400); };

  // ── ITEM QUERY TEMPLATE ──
  const itemFields = `
    item.id AS internalid,
    item.itemid AS sku,
    item.displayname AS item_name,
    item.description AS description,
    item.upccode AS upc,
    BUILTIN.DF(item.class) AS class_name,
    BUILTIN.DF(item.department) AS department,
    item.cost AS purchase_price,
    item.baseprice AS base_price,
    item.totalquantityonhand AS total_qty_on_hand
  `;

  // ── LOAD INVENTORY FOR AN ITEM ──
  const loadInventory = useCallback(async (itemId) => {
    setInvLoading(true);
    try {
      const [inv, levels] = await Promise.all([
        suiteql(`
          SELECT
            ib.location AS location_id,
            BUILTIN.DF(ib.location) AS location_name,
            BUILTIN.DF(ib.binnumber) AS bin_number,
            ib.binnumber AS bin_id,
            ib.quantityonhand AS qty_on_hand,
            ib.quantityavailable AS qty_available
          FROM inventorybalance ib
          WHERE ib.item = ${itemId}
            AND ib.quantityonhand > 0
          ORDER BY BUILTIN.DF(ib.location), BUILTIN.DF(ib.binnumber)
        `),
        suiteql(`
          SELECT
            ail.location AS location_id,
            BUILTIN.DF(ail.location) AS location_name,
            ail.preferredstocklevel AS preferred_level,
            ail.reorderpoint AS reorder_point
          FROM AggregateItemLocation ail
          WHERE ail.item = ${itemId}
        `),
      ]);
      setInventory(inv);
      setStockLevels(levels);
    } catch (e) {
      setError(`Inventory load failed: ${e.message}`);
    } finally { setInvLoading(false); }
  }, []);

  // ── SCAN HANDLER ──
  const handleScan = useCallback(async (val) => {
    const v = val.trim(); if (!v) return;
    setLoading(true); setError(null); setItem(null); setInventory([]); setStockLevels([]);

    const escaped = v.replace(/'/g, "''");

    try {
      // 1. Try UPC
      let rows = await suiteql(`SELECT ${itemFields} FROM item WHERE item.upccode = '${escaped}' AND item.isinactive = 'F'`, 1);

      // 2. If no UPC match, try SKU
      if (rows.length === 0) {
        rows = await suiteql(`SELECT ${itemFields} FROM item WHERE UPPER(item.itemid) = UPPER('${escaped}') AND item.isinactive = 'F'`, 1);
      }

      if (rows.length === 0) {
        setError(`No item found for '${v}'`);
        beepWarn(); doFlash("warn");
        setLoading(false);
        try { logActivity({ module: "item-lookup", action: "item-lookup", status: "success", details: `UPC/SKU "${v}" — not found` }); } catch (_) { }
        return;
      }

      const found = rows[0];
      setItem(found);
      beepOk(); doFlash("ok");
      setLoading(false);

      // Add to history (deduplicated by internalid)
      setHistory(prev => {
        const filtered = prev.filter(h => String(h.internalid) !== String(found.internalid));
        return [{ ...found, _time: new Date() }, ...filtered].slice(0, 10);
      });

      // Load inventory in parallel (two-stage loading)
      loadInventory(found.internalid);
      try { logActivity({ module: "item-lookup", action: "item-lookup", status: "success", details: `${found.sku} — ${found.item_name}`, sourceDocument: found.upc || found.sku }); } catch (_) { }
    } catch (e) {
      setError(`Lookup failed: ${e.message}`);
      beepWarn(); doFlash("warn");
      setLoading(false);
    }
  }, [itemFields, loadInventory]);

  // ── RESTORE FROM HISTORY ──
  const showFromHistory = useCallback((h) => {
    setItem(h); setError(null); setInventory([]); setStockLevels([]);
    loadInventory(h.internalid);
  }, [loadInventory]);

  // ── GROUP INVENTORY BY LOCATION ──
  const locationGroups = [];
  const locMap = {};
  inventory.forEach(row => {
    const ln = row.location_name || "Unknown";
    if (!locMap[ln]) { locMap[ln] = { name: ln, id: row.location_id, bins: [], total: 0, totalAvail: 0 }; locationGroups.push(locMap[ln]); }
    locMap[ln].bins.push(row);
    locMap[ln].total += Number(row.qty_on_hand) || 0;
    locMap[ln].totalAvail += Number(row.qty_available) || 0;
  });

  const totalOnHand = locationGroups.reduce((a, g) => a + g.total, 0);
  const totalAvailable = locationGroups.reduce((a, g) => a + g.totalAvail, 0);

  // Stock levels lookup by location_id
  const levelsMap = {};
  stockLevels.forEach(l => { levelsMap[String(l.location_id)] = l; });

  const fmt = (v) => v != null && v !== "" ? `$${Number(v).toFixed(2)}` : null;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* HEADER */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Logo /><span style={{ fontSize: 15, fontWeight: 700 }}>Item Lookup</span>
        </div>
        <button style={S.btnSm} onClick={onBack}>← Home</button>
      </div>

      <div style={{ padding: 16, ...fadeIn }}>
        {/* SCAN INPUT */}
        <div style={{
          ...S.card, textAlign: "center", padding: 20, marginBottom: 12,
          border: "2px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.04)",
        }}>
          <div style={{ fontSize: 12, color: "#3b82f6", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>
            Scan or Type UPC / SKU
          </div>
          <ScanInput inputRef={scanRef} onScan={handleScan} placeholder="Scan or type UPC / SKU..." flash={flash} />
          {loading && <PulsingDot color="#3b82f6" label="Looking up item…" />}
        </div>

        {error && <div style={S.err}>{error}</div>}

        {/* ITEM DETAIL CARD */}
        {item && (
          <div style={{ ...fadeIn }}>
            <div style={S.card}>
              {/* Header */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: "#e2e8f0" }}>{item.sku}</div>
                <div style={{ fontSize: 14, color: "#cbd5e1", marginTop: 2 }}>{item.item_name}</div>
                {item.upc && <div style={{ fontSize: 12, color: "#64748b", ...mono, marginTop: 4 }}>UPC {item.upc}</div>}
                {(item.class_name || item.department) && (
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                    {[item.class_name, item.department].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>

              {/* Pricing (muted) */}
              {(fmt(item.purchase_price) || fmt(item.base_price)) && (
                <div style={{
                  display: "flex", gap: 16, marginBottom: 14, padding: "8px 12px",
                  background: "rgba(255,255,255,0.03)", borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.06)",
                }}>
                  {fmt(item.purchase_price) && (
                    <div>
                      <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Cost</div>
                      <div style={{ fontSize: 13, color: "#94a3b8", ...mono }}>{fmt(item.purchase_price)}</div>
                    </div>
                  )}
                  {fmt(item.base_price) && (
                    <div>
                      <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Retail</div>
                      <div style={{ fontSize: 13, color: "#94a3b8", ...mono }}>{fmt(item.base_price)}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Inventory breakdown */}
              <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>
                Inventory by Location
              </div>

              {invLoading && <PulsingDot color="#22c55e" label="Loading inventory…" />}

              {!invLoading && locationGroups.length === 0 && (
                <div style={{
                  padding: 16, textAlign: "center", color: "#f59e0b", fontSize: 13,
                  background: "rgba(245,158,11,0.06)", borderRadius: 8, border: "1px solid rgba(245,158,11,0.2)",
                }}>
                  No inventory on hand in any location.
                </div>
              )}

              {locationGroups.map(loc => {
                const level = levelsMap[String(loc.id)];
                const preferred = level ? Number(level.preferred_level) || 0 : 0;
                const reorder = level ? Number(level.reorder_point) || 0 : 0;
                const belowReorder = reorder > 0 && loc.total <= reorder;
                const belowPreferred = preferred > 0 && loc.total < preferred && !belowReorder;

                return (
                  <div key={loc.name} style={{
                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 10, padding: 12, marginBottom: 8,
                  }}>
                    {/* Location header */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{loc.name}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: belowReorder ? "#ef4444" : belowPreferred ? "#f59e0b" : "#22c55e" }}>
                        {loc.total} total
                      </div>
                    </div>

                    {/* Stock level info */}
                    {level && (preferred > 0 || reorder > 0) && (
                      <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>
                        {preferred > 0 && <span>preferred: {preferred}</span>}
                        {preferred > 0 && reorder > 0 && <span> · </span>}
                        {reorder > 0 && <span>reorder: {reorder}</span>}
                        {belowReorder && <span style={{ color: "#ef4444", fontWeight: 700, marginLeft: 6 }}>⚠ Below reorder point</span>}
                      </div>
                    )}

                    {/* Bin rows */}
                    {loc.bins.map((bin, i) => {
                      const isReceiving = bin.bin_number && bin.bin_number.toUpperCase().startsWith("IN-");
                      return (
                        <div key={i} style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "6px 8px", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, ...mono, color: "#a5b4fc" }}>{bin.bin_number || "—"}</span>
                            {isReceiving && <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 600, textTransform: "uppercase" }}>(receiving)</span>}
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, ...mono, color: "#cbd5e1" }}>{bin.qty_on_hand}</span>
                            {Number(bin.qty_available) !== Number(bin.qty_on_hand) && (
                              <span style={{ fontSize: 11, color: "#64748b", ...mono }}>({bin.qty_available} avail)</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* Totals */}
              {!invLoading && locationGroups.length > 0 && (
                <div style={{
                  display: "flex", justifyContent: "space-between", padding: "10px 12px", marginTop: 4,
                  background: "rgba(34,197,94,0.06)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.15)",
                }}>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>
                    Total on hand: <span style={{ fontWeight: 700, color: "#22c55e", ...mono }}>{totalOnHand}</span>
                  </div>
                  {totalAvailable !== totalOnHand && (
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>
                      Available: <span style={{ fontWeight: 700, color: "#60a5fa", ...mono }}>{totalAvailable}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* HISTORY */}
        {history.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Recent Lookups
              </div>
              <button
                onClick={() => setHistory([])}
                style={{ background: "none", border: "none", color: "#475569", fontSize: 11, cursor: "pointer", fontFamily: "inherit", touchAction: "manipulation" }}
              >Clear History</button>
            </div>
            <div style={{ borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
              {history.map((h, i) => (
                <div
                  key={h.internalid}
                  onClick={() => showFromHistory(h)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 14px", cursor: "pointer", touchAction: "manipulation",
                    borderBottom: i < history.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                    background: item && String(item.internalid) === String(h.internalid) ? "rgba(59,130,246,0.06)" : "transparent",
                    minHeight: 48,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{h.sku}</div>
                    <div style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.item_name}</div>
                  </div>
                  <div style={{ textAlign: "right", marginLeft: 12, flexShrink: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, ...mono, color: "#22c55e" }}>{h.total_qty_on_hand ?? 0}</div>
                    <div style={{ fontSize: 9, color: "#475569" }}>
                      {h._time ? new Date(h._time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
