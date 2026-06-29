import { useEffect, useMemo, useRef, useState } from "react";
import {
  suiteql, S, FONT, ANIMATIONS, mono, Logo, PulsingDot, fadeIn,
  ScanInput, useScanRefocus, beepOk, beepWarn,
} from "../shared";

// ═══════════════════════════════════════════════════════════
// SplitFulfillScreen — handles one split-inventory order.
//
// Reached from PlanScreen when an order is flagged needsSplit (a line
// can't be sourced at its committed location but IS coverable across
// other locations). The picker is shown where the stock actually lives,
// scans the planned bin(s) at each location, and the app fires one
// Item Fulfillment per location (location override) via
// POST /api/sales-orders/:id/split-fulfill — the scripted version of
// the manual "change the IF line's location" path.
//
// Self-contained: does NOT touch the wave/lock machinery.
//
// v1 handles the first split line of an order (the overwhelming common
// case). Any additional split lines are surfaced as a notice rather
// than silently dropped.
// ═══════════════════════════════════════════════════════════

const ACCENT = "#22c55e";
const WARN = "#f59e0b";
const ERR = "#ef4444";

function formatDate(iso) {
  return iso ? String(iso).slice(0, 10) : "";
}

// FIFO-fill an allocation's qty from a location's available bins.
function fillBins(qty, bins) {
  let remaining = qty;
  const picks = [];
  for (const b of bins) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.available);
    if (take <= 0) continue;
    picks.push({ binId: b.binId, binNumber: b.binNumber, qty: take });
    remaining -= take;
  }
  return { picks, short: remaining };
}

export default function SplitFulfillScreen({ order, onDone, onBack }) {
  const line = order?.splitPlan?.[0] || null;
  const extraLines = (order?.splitPlan || []).slice(1);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [sku, setSku] = useState(null);
  const [plannedBins, setPlannedBins] = useState([]); // [{locationId, locationName, binId, binNumber, qty}]
  const [shortByLoc, setShortByLoc] = useState([]);   // locations we couldn't fully bin
  const [scannedByBin, setScannedByBin] = useState({}); // binId -> qty scanned
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const scanRef = useRef(null);

  // Fetch bins per allocation location and build the bin pick plan.
  useEffect(() => {
    if (!line) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const locIds = line.allocations.map((a) => Number(a.locationId)).filter(Number.isInteger);
        const rows = locIds.length
          ? await suiteql(`
              SELECT
                ib.location AS location_id,
                ib.binnumber AS bin_id,
                BUILTIN.DF(ib.binnumber) AS bin_name,
                ib.quantityavailable AS avail,
                BUILTIN.DF(ib.item) AS sku
              FROM inventorybalance ib
              WHERE ib.item = ${Number(line.itemId)}
                AND ib.location IN (${locIds.join(",")})
                AND NVL(ib.quantityavailable, 0) > 0
              ORDER BY ib.location, BUILTIN.DF(ib.binnumber)
            `)
          : [];
        const binsByLoc = {};
        for (const r of rows) {
          const lid = String(r.location_id);
          (binsByLoc[lid] ||= []).push({
            binId: r.bin_id != null ? String(r.bin_id) : null,
            binNumber: r.bin_name,
            available: Number(r.avail) || 0,
          });
        }
        const planned = [];
        const shorts = [];
        for (const a of line.allocations) {
          const lid = String(a.locationId);
          const { picks, short } = fillBins(Number(a.qty) || 0, binsByLoc[lid] || []);
          for (const p of picks) {
            planned.push({ locationId: lid, locationName: a.locationName || `#${lid}`, ...p });
          }
          if (short > 0) shorts.push({ locationId: lid, locationName: a.locationName || `#${lid}`, short });
        }
        if (cancelled) return;
        setSku(rows[0]?.sku || null);
        setPlannedBins(planned);
        setShortByLoc(shorts);
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  const totalNeed = useMemo(() => plannedBins.reduce((s, p) => s + p.qty, 0), [plannedBins]);
  const totalScanned = useMemo(
    () => plannedBins.reduce((s, p) => s + Math.min(scannedByBin[p.binId] || 0, p.qty), 0),
    [plannedBins, scannedByBin]
  );
  const allScanned = plannedBins.length > 0 && plannedBins.every((p) => (scannedByBin[p.binId] || 0) >= p.qty);

  const binByName = useMemo(() => {
    const m = {};
    for (const p of plannedBins) m[String(p.binNumber || "").toUpperCase()] = p;
    return m;
  }, [plannedBins]);

  // Group planned bins by location for display.
  const byLocation = useMemo(() => {
    const map = {};
    for (const p of plannedBins) {
      (map[p.locationId] ||= { locationId: p.locationId, locationName: p.locationName, bins: [] }).bins.push(p);
    }
    return Object.values(map);
  }, [plannedBins]);

  useScanRefocus(scanRef, !loading && !result && !submitting && !loadError);

  function showBanner(kind, text) { setBanner({ kind, text }); }

  function handleScan(raw) {
    const val = String(raw || "").trim();
    if (!val) return;
    const p = binByName[val.toUpperCase()];
    if (!p) { beepWarn(); showBanner("warn", `Bin "${val}" isn't part of this split`); return; }
    const already = scannedByBin[p.binId] || 0;
    if (already >= p.qty) { beepWarn(); showBanner("warn", `${p.binNumber} already fully scanned`); return; }
    setScannedByBin((prev) => ({ ...prev, [p.binId]: (prev[p.binId] || 0) + 1 }));
    beepOk();
    showBanner("ok", `+1 from ${p.binNumber}`);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const byLoc = {};
      for (const p of plannedBins) {
        (byLoc[p.locationId] ||= []).push({ binId: p.binId, quantity: p.qty });
      }
      const allocations = Object.entries(byLoc).map(([locationId, bins]) => ({ locationId, bins }));
      const r = await fetch(`/api/sales-orders/${encodeURIComponent(order.id)}/split-fulfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: line.itemId,
          // Only mark the order shipped-complete when this split fully
          // covers it: no unhandled extra split lines AND no bin-level
          // shortage. Otherwise ship what we have and leave it Partially
          // Fulfilled so the owed units aren't silently closed out.
          completesOrder: extraLines.length === 0 && shortByLoc.length === 0,
          allocations,
        }),
      });
      const d = await r.json();
      if (!r.ok && d?.status !== "partial") throw new Error(d?.error || `API ${r.status}`);
      setResult(d);
      if (d.status === "complete") beepOk(); else beepWarn();
    } catch (e) {
      setError(e.message);
      beepWarn();
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Nothing to split ─────────────────────────────────────────
  if (!order || !line) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ ...S.card, padding: 20, textAlign: "center", color: "#94a3b8" }}>
            Nothing to split for this order.
          </div>
        </div>
      </div>
    );
  }

  // ─── Loading / load error ─────────────────────────────────────
  if (loading) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
        </div>
        <div style={{ padding: 16 }}>
          <PulsingDot color={WARN} label="Finding stock across locations..." />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={S.err}>{loadError}</div>
        </div>
      </div>
    );
  }

  // ─── Result view ──────────────────────────────────────────────
  if (result) {
    const rows = result.results || [];
    const heading =
      result.status === "complete" ? "✓ Fulfilled across locations"
      : result.status === "partial" ? "⚠ Partially fulfilled"
      : "✗ Fulfillment failed";
    const headColor = result.status === "complete" ? ACCENT : result.status === "partial" ? WARN : ERR;
    const nameByLoc = {};
    for (const p of plannedBins) nameByLoc[p.locationId] = p.locationName;
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={() => onDone(order.id, result.status)} style={{ ...S.btnSm, fontSize: 12 }}>Done →</button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ ...S.card, padding: 16, marginBottom: 12, background: `${headColor}12`, border: `1px solid ${headColor}35` }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: headColor, marginBottom: 4 }}>{heading}</div>
            <div style={{ fontSize: 12, color: "#cbd5e1", ...mono }}>
              {order.tranId || `#${order.id}`} · {sku || `item ${line.itemId}`}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r, i) => {
              const ok = r.status === "fulfilled";
              const color = ok ? ACCENT : r.status === "skipped_empty" ? "#64748b" : ERR;
              return (
                <div key={i} style={{ ...S.card, padding: "10px 12px", border: `1px solid ${color}30`, background: `${color}06` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>
                      {nameByLoc[String(r.locationId)] || `Location #${r.locationId}`}
                    </span>
                    <span style={{ fontSize: 11, color, ...mono }}>
                      {ok ? `IF ${r.fulfillmentId}` : r.status}
                    </span>
                  </div>
                  {r.error && <div style={{ fontSize: 11, color: ERR, marginTop: 2 }}>{r.error}</div>}
                </div>
              );
            })}
          </div>

          {result.status === "partial" && (
            <div style={{ ...S.card, padding: 12, marginTop: 12, background: `${WARN}0c`, border: `1px solid ${WARN}35` }}>
              <div style={{ fontSize: 12, color: WARN, lineHeight: 1.5 }}>
                Some locations shipped and some did not. The order is Partially Fulfilled — finish the
                remaining location(s) before treating it as done.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Main pick view ───────────────────────────────────────────
  const bannerColor = banner ? (banner.kind === "ok" ? ACCENT : banner.kind === "err" ? ERR : WARN) : null;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 14, fontWeight: 700 }}>Split Fulfill</span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      <div style={{ padding: "12px 16px 140px", ...fadeIn }}>
        {/* Order + item summary */}
        <div style={{ ...S.card, padding: 12, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", ...mono }}>
            {order.tranId || `#${order.id}`}
            {order.shopifyOrderNumber ? <span style={{ color: "#64748b", fontWeight: 400 }}> · #{order.shopifyOrderNumber}</span> : null}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            {order.customerName || "—"} · {formatDate(order.orderDate)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#cbd5e1", marginTop: 8, ...mono }}>
            {sku || `item ${line.itemId}`}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            Scan each bin to confirm the pick, then fulfill across locations.
          </div>
        </div>

        {/* Progress */}
        <div style={{ ...S.card, padding: 10, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
            <span style={{ color: "#94a3b8" }}>Scanned</span>
            <span style={{ color: "#e2e8f0", fontWeight: 700, ...mono }}>{totalScanned} / {totalNeed}</span>
          </div>
        </div>

        {/* Scan input */}
        <div style={{ ...S.card, padding: 12, marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 11, color: "#94a3b8", marginBottom: 4, letterSpacing: 0.3 }}>
            SCAN BIN
          </label>
          <ScanInput onScan={handleScan} placeholder="Scan bin..." inputRef={scanRef} />
        </div>

        {banner && (
          <div style={{
            padding: "6px 10px", marginBottom: 8, borderRadius: 4,
            background: `${bannerColor}18`, border: `1px solid ${bannerColor}55`,
            color: bannerColor, fontSize: 12, fontWeight: 600, ...mono,
          }}>
            {banner.text}
          </div>
        )}

        {/* Per-location bin plan */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {byLocation.map((loc) => (
            <div key={loc.locationId} style={{ ...S.card, padding: 12, border: `1px solid ${WARN}30`, background: `${WARN}06` }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 6 }}>
                📍 {loc.locationName}
              </div>
              {loc.bins.map((p) => {
                const scanned = Math.min(scannedByBin[p.binId] || 0, p.qty);
                const done = scanned >= p.qty;
                return (
                  <div key={p.binId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderTop: "1px solid #1e293b" }}>
                    <span style={{ fontSize: 13, color: done ? "#64748b" : "#e2e8f0", ...mono, fontWeight: 600 }}>
                      {p.binNumber}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: done ? ACCENT : WARN, ...mono }}>
                      {scanned}/{p.qty}{done ? " ✓" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Shortage / extra-line notices */}
        {shortByLoc.length > 0 && (
          <div style={{ ...S.card, padding: 10, marginTop: 8, background: `${ERR}0c`, border: `1px solid ${ERR}35` }}>
            <div style={{ fontSize: 11, color: ERR, lineHeight: 1.5 }}>
              Couldn't find enough bin stock at: {shortByLoc.map((s) => `${s.locationName} (short ${s.short})`).join(", ")}.
              Those units won't be fulfilled here.
            </div>
          </div>
        )}
        {extraLines.length > 0 && (
          <div style={{ ...S.card, padding: 10, marginTop: 8, background: `${WARN}0c`, border: `1px solid ${WARN}35` }}>
            <div style={{ fontSize: 11, color: WARN, lineHeight: 1.5 }}>
              This order has {extraLines.length} more split line{extraLines.length === 1 ? "" : "s"} not handled here
              ({extraLines.map((l) => `item ${l.itemId}`).join(", ")}). Fulfill {extraLines.length === 1 ? "it" : "them"} separately.
            </div>
          </div>
        )}

        {error && <div style={{ ...S.err, marginTop: 8 }}>{error}</div>}
      </div>

      {/* Fulfill bar */}
      <div style={{
        position: "fixed", left: 0, right: 0, bottom: 0, padding: 12,
        background: "#0b1220", borderTop: "1px solid #1e293b",
        display: "flex", alignItems: "center", gap: 10, zIndex: 3,
      }}>
        <div style={{ fontSize: 11, color: "#64748b", flex: 1, ...mono }}>
          {totalScanned}/{totalNeed} scanned
        </div>
        <button
          onClick={submit}
          disabled={!allScanned || submitting}
          style={{
            padding: "10px 18px",
            background: !allScanned ? "#334155" : ACCENT,
            color: "#0f172a", fontSize: 14, fontWeight: 700,
            border: "none", borderRadius: 6,
            cursor: !allScanned || submitting ? "default" : "pointer",
            opacity: submitting ? 0.6 : 1, touchAction: "manipulation",
          }}
        >
          {submitting ? "Fulfilling..." : "Fulfill across locations"}
        </button>
      </div>
    </div>
  );
}
