import { useEffect, useMemo, useRef, useState } from "react";
import {
  S, FONT, ANIMATIONS, mono, Logo, PulsingDot, fadeIn,
  ScanInput, useScanRefocus, beepOk, beepWarn,
  loadSession, saveSession, clearSession,
} from "../shared";

// ═══════════════════════════════════════════════════════════
// PlanScreen
//
// Multi-location pick planning. Picker scans a stack of Shopify
// (or NetSuite) order numbers in any order; the app resolves each
// against NS and groups them by source location. Once resolved
// the picker walks each location's wave one at a time. Locations
// the picker has already finished are stamped ✓ and stay visible
// for reference.
//
// Plan is persisted to localStorage so a refresh / app close
// mid-plan doesn't lose progress.
// ═══════════════════════════════════════════════════════════

const ACCENT = "#22c55e";
const WARN = "#f59e0b";
const ERR = "#ef4444";
const PLAN_KEY = "glww_so_plan_v1";
const PICKER_NAME_KEY = "glww_picker_name";

function formatDate(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}
const normalize = (raw) => String(raw || "").trim().toUpperCase().replace(/^#/, "");

function loadPlan() {
  const p = loadSession(PLAN_KEY);
  if (!p || typeof p !== "object") return null;
  return {
    pickerName: typeof p.pickerName === "string" ? p.pickerName : "",
    scanned: Array.isArray(p.scanned) ? p.scanned : [],
    resolved: Array.isArray(p.resolved) ? p.resolved : [],
    unresolved: Array.isArray(p.unresolved) ? p.unresolved : [],
    completedLocations: Array.isArray(p.completedLocations) ? p.completedLocations : [],
    startedAt: p.startedAt || null,
  };
}

export default function PlanScreen({ onPickAtLocation, onBrowseByLocation, onBack, completionSignal }) {
  const persisted = useMemo(loadPlan, []);
  const [pickerName, setPickerName] = useState(() => persisted?.pickerName || loadSession(PICKER_NAME_KEY) || "");
  const [scanned, setScanned] = useState(() => persisted?.scanned || []);
  const [resolved, setResolved] = useState(() => persisted?.resolved || []);
  const [unresolved, setUnresolved] = useState(() => persisted?.unresolved || []);
  const [completedLocations, setCompletedLocations] = useState(() => persisted?.completedLocations || []);
  const [resolving, setResolving] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [nameFocused, setNameFocused] = useState(false);
  const scanInputRef = useRef(null);

  useScanRefocus(scanInputRef, !resolving && !nameFocused);

  // When a wave completion bubbles up from the parent, mark that
  // location done. The parent bumps `completionSignal.n` even if the
  // same locationId completes twice, so the effect refires reliably.
  useEffect(() => {
    if (!completionSignal?.locationId || !completionSignal?.n) return;
    setCompletedLocations((prev) =>
      prev.includes(completionSignal.locationId) ? prev : [...prev, completionSignal.locationId]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completionSignal?.n]);

  // Persist on every meaningful change.
  useEffect(() => {
    if (scanned.length === 0 && resolved.length === 0 && unresolved.length === 0) {
      clearSession(PLAN_KEY);
      return;
    }
    saveSession(PLAN_KEY, {
      pickerName,
      scanned,
      resolved,
      unresolved,
      completedLocations,
      startedAt: persisted?.startedAt || new Date().toISOString(),
    });
  }, [pickerName, scanned, resolved, unresolved, completedLocations, persisted?.startedAt]);

  // Group resolved orders by location. Each SO can show up under
  // multiple locations if its lines are split across them.
  const ordersByLocation = useMemo(() => {
    const map = {}; // locationId -> { locationId, locationName, orders: [{order, lineCount, totalQty}] }
    for (const o of resolved) {
      for (const pl of o.perLocation || []) {
        if (!pl.locationId) continue;
        if (!map[pl.locationId]) {
          map[pl.locationId] = { locationId: pl.locationId, locationName: pl.locationName || `#${pl.locationId}`, orders: [] };
        }
        map[pl.locationId].orders.push({ order: o, lineCount: pl.lineCount, totalQty: pl.totalQty });
      }
    }
    return Object.values(map).sort((a, b) =>
      a.locationName.localeCompare(b.locationName, undefined, { sensitivity: "base" })
    );
  }, [resolved]);

  const totalSOs = resolved.length;
  const totalLocations = ordersByLocation.length;
  const completedCount = ordersByLocation.filter((g) => completedLocations.includes(g.locationId)).length;

  const handleScan = async (raw) => {
    const val = normalize(raw);
    if (!val) return;
    if (scanned.includes(val)) {
      setScanError(`Already scanned "${raw}"`);
      beepWarn();
      return;
    }
    setScanError(null);
    setResolving(true);
    try {
      const r = await fetch("/api/sales-orders/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [val] }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `API ${r.status}`);

      setScanned((prev) => [...prev, val]);

      const newResolved = (data.resolved || []).filter(
        (o) => !resolved.some((existing) => existing.id === o.id)
      );
      if (newResolved.length > 0) {
        setResolved((prev) => [...prev, ...newResolved]);
        beepOk();
      }
      const newUnresolved = (data.unresolved || []).filter((u) => !unresolved.includes(u));
      if (newUnresolved.length > 0) {
        setUnresolved((prev) => [...prev, ...newUnresolved]);
        beepWarn();
        setScanError(`No open Pending SO matched "${raw}"`);
      } else if (newResolved.length === 0 && data.resolved?.length > 0) {
        // We got a hit, but the SO was already in the plan (duplicate Shopify number → same NS SO).
        setScanError(`Already in plan: ${data.resolved[0].tranId || data.resolved[0].id}`);
      }
    } catch (e) {
      setScanError(e.message);
      beepWarn();
    } finally {
      setResolving(false);
    }
  };

  const removeResolved = (orderId) => {
    setResolved((prev) => {
      const o = prev.find((x) => x.id === orderId);
      const next = prev.filter((x) => x.id !== orderId);
      if (o) {
        // Also drop the scan key(s) that produced it so a re-scan works.
        setScanned((s) =>
          s.filter((k) => k !== o.shopifyOrderNumber && k !== String(o.tranId || "").toUpperCase())
        );
      }
      return next;
    });
  };

  const dismissUnresolved = (key) => {
    setUnresolved((prev) => prev.filter((k) => k !== key));
    setScanned((s) => s.filter((k) => k !== key));
  };

  const startWaveAt = (group) => {
    if (!pickerName.trim()) {
      setScanError("Enter picker name first");
      return;
    }
    saveSession(PICKER_NAME_KEY, pickerName.trim());
    onPickAtLocation({
      locationId: group.locationId,
      locationName: group.locationName,
      soIds: group.orders.map((entry) => entry.order.id),
      pickerName: pickerName.trim(),
    });
  };

  const clearPlan = () => {
    if (!confirm("Clear the current plan? Scanned orders will be removed (in-progress waves are unaffected).")) return;
    setScanned([]);
    setResolved([]);
    setUnresolved([]);
    setCompletedLocations([]);
    setScanError(null);
    clearSession(PLAN_KEY);
  };

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>
            Pick Sales Orders
          </span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      <div style={{ padding: "12px 16px 120px" }}>
        <div style={fadeIn}>
          {/* Picker name */}
          <div style={{ ...S.card, padding: 12, marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", marginBottom: 4, letterSpacing: 0.3 }}>
              PICKER NAME
            </label>
            <input
              value={pickerName}
              onChange={(e) => setPickerName(e.target.value)}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              placeholder="Your name"
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 14,
                background: "#0f172a",
                border: "1px solid #334155",
                borderRadius: 6,
                color: "#e2e8f0",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Scan input */}
          <div style={{ ...S.card, padding: 12, marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", marginBottom: 4, letterSpacing: 0.3 }}>
              SCAN ORDER #s (Shopify or NetSuite)
            </label>
            <ScanInput
              onScan={handleScan}
              placeholder={resolving ? "Resolving..." : "Scan order #..."}
              inputRef={scanInputRef}
            />
            {scanError && (
              <div style={{ fontSize: 11, color: WARN, marginTop: 6, ...mono }}>{scanError}</div>
            )}
          </div>

          {/* Plan summary */}
          {(totalSOs > 0 || unresolved.length > 0) && (
            <div
              style={{
                ...S.card,
                padding: "10px 12px",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 12, color: "#cbd5e1", ...mono }}>
                {totalSOs} SO{totalSOs === 1 ? "" : "s"} · {totalLocations} location{totalLocations === 1 ? "" : "s"}
                {completedCount > 0 ? ` · ${completedCount} done` : ""}
              </div>
              <button
                onClick={clearPlan}
                style={{
                  padding: "4px 10px",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  color: ERR,
                  background: `${ERR}10`,
                  border: `1px solid ${ERR}40`,
                  borderRadius: 4,
                  cursor: "pointer",
                  textTransform: "uppercase",
                }}
              >
                Clear plan
              </button>
            </div>
          )}

          {/* Unresolved scans */}
          {unresolved.length > 0 && (
            <div
              style={{
                ...S.card,
                padding: 10,
                marginBottom: 10,
                background: `${ERR}08`,
                border: `1px solid ${ERR}30`,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: ERR, marginBottom: 6, letterSpacing: 0.3 }}>
                NOT FOUND ({unresolved.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {unresolved.map((k) => (
                  <button
                    key={k}
                    onClick={() => dismissUnresolved(k)}
                    title="Tap to dismiss"
                    style={{
                      padding: "3px 10px",
                      fontSize: 11,
                      color: ERR,
                      background: `${ERR}15`,
                      border: `1px solid ${ERR}40`,
                      borderRadius: 12,
                      cursor: "pointer",
                      ...mono,
                    }}
                  >
                    #{k} ✕
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Per-location waves */}
          {ordersByLocation.length === 0 && totalSOs === 0 && unresolved.length === 0 && (
            <div style={{ ...S.card, textAlign: "center", padding: 24, color: "#94a3b8" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#cbd5e1", marginBottom: 4 }}>
                Scan order numbers to begin
              </div>
              <div style={{ fontSize: 11 }}>
                Each scanned order is grouped by source location.
              </div>
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={onBrowseByLocation}
                  style={{
                    padding: "8px 14px",
                    fontSize: 12,
                    color: "#cbd5e1",
                    background: "transparent",
                    border: "1px solid #334155",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  Or pick by location →
                </button>
              </div>
            </div>
          )}

          {ordersByLocation.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ordersByLocation.map((group) => {
                const done = completedLocations.includes(group.locationId);
                return (
                  <div
                    key={group.locationId}
                    style={{
                      ...S.card,
                      padding: 12,
                      border: done ? `1px solid #334155` : `1px solid ${ACCENT}30`,
                      background: done ? "rgba(30,41,59,0.6)" : `${ACCENT}06`,
                      opacity: done ? 0.7 : 1,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>
                          {done ? "✓ " : "📍 "}{group.locationName}
                        </div>
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, ...mono }}>
                          {group.orders.length} SO{group.orders.length === 1 ? "" : "s"} · {group.orders.reduce((s, e) => s + e.totalQty, 0)} qty
                        </div>
                      </div>
                      <button
                        onClick={() => startWaveAt(group)}
                        disabled={done}
                        style={{
                          padding: "8px 14px",
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#0f172a",
                          background: done ? "#475569" : ACCENT,
                          border: "none",
                          borderRadius: 4,
                          cursor: done ? "default" : "pointer",
                          touchAction: "manipulation",
                          flexShrink: 0,
                        }}
                      >
                        {done ? "Done" : "Pick →"}
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {group.orders.map((entry) => {
                        const o = entry.order;
                        return (
                          <div
                            key={o.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "baseline",
                              gap: 8,
                              padding: "4px 0",
                              borderTop: "1px solid #1e293b",
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                                {o.tranId || `#${o.id}`}
                                {o.shopifyOrderNumber ? <span style={{ color: "#64748b", fontWeight: 400 }}> · #{o.shopifyOrderNumber}</span> : null}
                              </div>
                              <div style={{ fontSize: 10, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {o.customerName || "—"} · {formatDate(o.orderDate)}
                              </div>
                            </div>
                            <div style={{ fontSize: 10, color: "#64748b", ...mono, flexShrink: 0 }}>
                              {entry.lineCount} line{entry.lineCount === 1 ? "" : "s"} · {entry.totalQty} qty
                            </div>
                            {!done && (
                              <button
                                onClick={() => removeResolved(o.id)}
                                title="Remove this order from the plan"
                                style={{
                                  padding: "2px 6px",
                                  fontSize: 10,
                                  color: "#94a3b8",
                                  background: "transparent",
                                  border: "1px solid #334155",
                                  borderRadius: 3,
                                  cursor: "pointer",
                                  flexShrink: 0,
                                }}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer link to old single-location flow */}
          {totalSOs > 0 && (
            <div style={{ marginTop: 14, textAlign: "center" }}>
              <button
                onClick={onBrowseByLocation}
                style={{
                  fontSize: 11,
                  color: "#64748b",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Or browse by location instead
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
