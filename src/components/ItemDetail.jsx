import { useState, useEffect, useRef, useCallback } from "react";
import { suiteql, S, mono, PulsingDot } from "../shared";

// ═══════════════════════════════════════════════════════════
// ITEM DETAIL DRAWER — shared component for all modules
// ═══════════════════════════════════════════════════════════

// Session-level cache so repeat taps are instant
const itemCache = {};

const DRAWER_STYLES = `
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes slideDown { from { transform: translateY(0); } to { transform: translateY(100%); } }
@keyframes fadeOverlayIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fadeOverlayOut { from { opacity: 1; } to { opacity: 0; } }
`;

/**
 * ItemDetailDrawer — slide-up panel showing full item info + inventory by location/bin.
 *
 * Props:
 *   itemId        – NetSuite internal ID (number|string). null = closed.
 *   onClose       – callback when drawer is dismissed
 *   refocusRef    – optional ref to re-focus (e.g. scan input) after close
 */
export default function ItemDetailDrawer({ itemId, onClose, refocusRef }) {
  const [data, setData] = useState(null);      // { item, inventory }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);
  const drawerRef = useRef(null);
  const touchStartY = useRef(null);

  // ── FETCH ──
  const fetchItem = useCallback(async (id) => {
    if (itemCache[id]) { setData(itemCache[id]); setLoading(false); return; }
    setLoading(true); setError(null); setData(null);
    try {
      const items = await suiteql(`
        SELECT
          item.id AS internalid,
          item.itemid AS sku,
          item.displayname AS item_name,
          item.description AS description,
          item.upccode AS upc,
          item.type AS item_type,
          BUILTIN.DF(item.class) AS class_name,
          BUILTIN.DF(item.department) AS department,
          item.cost AS purchase_price,
          item.baseprice AS base_price,
          item.totalquantityonhand AS total_qty_on_hand
        FROM item
        WHERE item.id = ${id}
      `, 1);
      if (items.length === 0) { setError("Item not found"); setLoading(false); return; }

      const inventory = await suiteql(`
        SELECT
          ib.location AS location_id,
          BUILTIN.DF(ib.location) AS location_name,
          BUILTIN.DF(ib.binnumber) AS bin_number,
          ib.quantityonhand AS qty_on_hand,
          ib.quantityavailable AS qty_available
        FROM inventorybalance ib
        WHERE ib.item = ${id}
          AND ib.quantityonhand > 0
        ORDER BY BUILTIN.DF(ib.location), BUILTIN.DF(ib.binnumber)
      `);

      const result = { item: items[0], inventory };
      itemCache[id] = result;
      setData(result);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (itemId) { fetchItem(itemId); setClosing(false); }
    else { setData(null); setError(null); }
  }, [itemId, fetchItem]);

  // ── CLOSE ANIMATION ──
  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
      if (refocusRef?.current) setTimeout(() => refocusRef.current.focus(), 50);
    }, 180);
  }, [onClose, refocusRef]);

  // ── SWIPE TO CLOSE ──
  const onTouchStart = (e) => { touchStartY.current = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    if (touchStartY.current === null) return;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (dy > 60) handleClose();
    touchStartY.current = null;
  };

  // ── REFRESH (clear cache + re-query) ──
  const refresh = () => {
    if (itemId) { delete itemCache[itemId]; fetchItem(itemId); }
  };

  if (!itemId) return null;

  // ── GROUP INVENTORY BY LOCATION ──
  const locationGroups = [];
  if (data?.inventory) {
    const map = {};
    data.inventory.forEach(row => {
      const ln = row.location_name || "Unknown";
      if (!map[ln]) { map[ln] = { name: ln, bins: [], total: 0 }; locationGroups.push(map[ln]); }
      map[ln].bins.push(row);
      map[ln].total += Number(row.qty_on_hand) || 0;
    });
  }

  const fmt = (v) => v != null && v !== "" ? `$${Number(v).toFixed(2)}` : null;

  return (
    <>
      <style>{DRAWER_STYLES}</style>

      {/* OVERLAY */}
      <div
        onClick={handleClose}
        style={{
          position: "fixed", inset: 0, zIndex: 900,
          background: "rgba(0,0,0,0.5)",
          animation: closing ? "fadeOverlayOut 180ms ease-in forwards" : "fadeOverlayIn 180ms ease-out",
        }}
      />

      {/* DRAWER */}
      <div
        ref={drawerRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 910,
          maxHeight: "70vh", minHeight: "40vh",
          background: "#1e293b",
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          boxShadow: "0 -4px 24px rgba(0,0,0,0.4)",
          overflowY: "auto", WebkitOverflowScrolling: "touch",
          animation: closing ? "slideDown 180ms ease-in forwards" : "slideUp 200ms ease-out",
        }}
      >
        {/* Handle bar */}
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 4px" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)" }} />
        </div>

        <div style={{ padding: "4px 16px 24px" }}>
          {/* LOADING */}
          {loading && <PulsingDot color="#3b82f6" label="Loading item details…" />}

          {/* ERROR */}
          {error && <div style={S.err}>{error}</div>}

          {/* CONTENT */}
          {data && (
            <>
              {/* ── HEADER ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: "#e2e8f0", lineHeight: 1.3 }}>{data.item.sku}</div>
                <div style={{ fontSize: 14, color: "#cbd5e1", marginTop: 2 }}>{data.item.item_name}</div>
                {data.item.upc && <div style={{ fontSize: 12, color: "#64748b", ...mono, marginTop: 4 }}>UPC {data.item.upc}</div>}
                {(data.item.class_name || data.item.department) && (
                  <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>
                    {[data.item.class_name, data.item.department].filter(Boolean).join(" · ")}
                  </div>
                )}
                {data.item.description && <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, lineHeight: 1.4 }}>{data.item.description}</div>}
              </div>

              {/* ── PRICING (muted) ── */}
              {(fmt(data.item.purchase_price) || fmt(data.item.base_price)) && (
                <div style={{
                  display: "flex", gap: 16, marginBottom: 14, padding: "8px 12px",
                  background: "rgba(255,255,255,0.03)", borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.06)",
                }}>
                  {fmt(data.item.purchase_price) && (
                    <div>
                      <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Cost</div>
                      <div style={{ fontSize: 13, color: "#94a3b8", ...mono }}>{fmt(data.item.purchase_price)}</div>
                    </div>
                  )}
                  {fmt(data.item.base_price) && (
                    <div>
                      <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Retail</div>
                      <div style={{ fontSize: 13, color: "#94a3b8", ...mono }}>{fmt(data.item.base_price)}</div>
                    </div>
                  )}
                </div>
              )}

              {/* ── INVENTORY ── */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                  <div>
                    <span style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Total On Hand</span>
                    <span style={{ fontSize: 22, fontWeight: 700, ...mono, color: "#22c55e", marginLeft: 10 }}>
                      {data.item.total_qty_on_hand ?? 0}
                    </span>
                  </div>
                  <button onClick={refresh} style={{
                    background: "none", border: "none", color: "#475569", fontSize: 11,
                    cursor: "pointer", fontFamily: "inherit", padding: "4px 8px",
                    touchAction: "manipulation",
                  }}>↻ Refresh</button>
                </div>

                {locationGroups.length === 0 && !loading && (
                  <div style={{ padding: 16, textAlign: "center", color: "#f59e0b", fontSize: 13,
                    background: "rgba(245,158,11,0.06)", borderRadius: 8, border: "1px solid rgba(245,158,11,0.2)" }}>
                    No inventory on hand in any location.
                  </div>
                )}

                {locationGroups.map(loc => (
                  <div key={loc.name} style={{
                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 10, padding: 12, marginBottom: 8,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{loc.name}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, ...mono, color: "#22c55e" }}>{loc.total}</div>
                    </div>
                    {loc.bins.map((bin, i) => (
                      <div key={i} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "6px 8px", borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
                      }}>
                        <div style={{ fontSize: 13, ...mono, color: "#a5b4fc" }}>{bin.bin_number || "—"}</div>
                        <div style={{ fontSize: 14, fontWeight: 600, ...mono, color: "#cbd5e1" }}>{bin.qty_on_hand}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* ── CLOSE BUTTON ── */}
              <button
                onClick={handleClose}
                style={{ ...S.btnSec, width: "100%", textAlign: "center", marginTop: 4 }}
              >Close</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Helper: wrap an item row so tapping it opens the drawer.
 * Usage:
 *   const { drawerItemId, openDrawer, closeDrawer, DrawerComponent } = useItemDetailDrawer(scanInputRef);
 *   ... openDrawer(item.internalid || item.item_id) on row click ...
 *   {DrawerComponent}
 */
export function useItemDetailDrawer(refocusRef) {
  const [drawerItemId, setDrawerItemId] = useState(null);

  const openDrawer = useCallback((id) => {
    if (id) setDrawerItemId(String(id));
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerItemId(null);
  }, []);

  const DrawerComponent = drawerItemId ? (
    <ItemDetailDrawer itemId={drawerItemId} onClose={closeDrawer} refocusRef={refocusRef} />
  ) : null;

  return { drawerItemId, openDrawer, closeDrawer, DrawerComponent };
}
