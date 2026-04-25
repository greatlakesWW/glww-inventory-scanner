import { useEffect, useMemo, useRef, useState } from "react";
import { S, FONT, ANIMATIONS, mono, Logo, PulsingDot, fadeIn, ScanInput, useScanRefocus, beepOk, beepWarn, loadSession, saveSession, clearSession } from "../shared";

// ═══════════════════════════════════════════════════════════
// SOListScreen
//
// Step 2 of SO Pick — lists open (Pending Fulfillment) Sales
// Orders at the selected source location. Picker can multi-
// select (tap rows) or scan an SO# to add it, then tap
// "Start Pick" to create a wave session and move to picking.
//
// Remembers picker name in localStorage so the repeat UX is
// one tap: scan your first SO, tap Start.
// ═══════════════════════════════════════════════════════════

const ACCENT = "#22c55e";
const PICKER_NAME_KEY = "glww_picker_name";

function formatDate(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

function formatRelative(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function LockBadge({ order }) {
  if (!order.lockedBy) return null;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 12,
        background: "rgba(245,158,11,0.12)",
        border: "1px solid rgba(245,158,11,0.35)",
        color: "#f59e0b",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        ...mono,
      }}
    >
      {order.lockedBy} · {formatRelative(order.lockedAt)}
    </span>
  );
}

export default function SOListScreen({ location, onStartPick, onBack }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [pickerName, setPickerName] = useState(() => loadSession(PICKER_NAME_KEY) || "");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [nameFocused, setNameFocused] = useState(false);
  const scanInputRef = useRef(null);

  // Don't auto-refocus the scan box while the picker is typing their
  // name; the useScanRefocus click handler would otherwise steal focus
  // every time they touch the name input.
  useScanRefocus(scanInputRef, !loading && !starting && !nameFocused);

  useEffect(() => {
    if (!location?.id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch(`/api/sales-orders?location=${encodeURIComponent(location.id)}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `API error ${resp.status}`);
        if (!cancelled) setOrders(Array.isArray(data.orders) ? data.orders : []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load sales orders");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [location?.id]);

  // Lookup map covers three scan formats:
  //   - NetSuite tranId (e.g. "SO2707")
  //   - NetSuite internal id (e.g. "529684")
  //   - Shopify order number (e.g. "25333" or "#25333") — stamped on
  //     each Connector-imported SO under custbody_fa_channel_order.
  // Keys are normalised: uppercased and stripped of leading "#" so
  // "25333" and "#25333" both match.
  const normalize = (raw) => String(raw || "").trim().toUpperCase().replace(/^#/, "");
  const orderByTran = useMemo(() => {
    const m = {};
    for (const o of orders) {
      if (o.tranId) m[normalize(o.tranId)] = o;
      m[normalize(o.id)] = o;
      if (o.shopifyOrderNumber) m[normalize(o.shopifyOrderNumber)] = o;
    }
    return m;
  }, [orders]);

  const toggle = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleScan = (raw) => {
    const val = normalize(raw);
    if (!val) return;
    const hit = orderByTran[val];
    if (!hit) { beepWarn(); setStartError(`No open SO matches "${raw}"`); return; }
    setStartError(null);
    beepOk();
    toggle(String(hit.id));
  };

  const selectedCount = selectedIds.size;

  const postSession = async ({ force }) => {
    const name = pickerName.trim();
    const resp = await fetch("/api/so-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pickerName: name,
        locationId: String(location.id),
        soIds: [...selectedIds],
        ...(force ? { force: true } : {}),
      }),
    });
    const data = await resp.json();
    return { resp, data };
  };

  const describeLock = (c) => {
    const tran = orderByTran[String(c.soId)]?.tranId || `#${c.soId}`;
    const when = c.lockedAt ? ` · locked ${formatRelative(c.lockedAt)}` : "";
    return `${tran} by ${c.lockedBy}${when}`;
  };

  const startPick = async () => {
    setStartError(null);
    const name = pickerName.trim();
    if (!name) { setStartError("Enter picker name"); return; }
    if (selectedCount === 0) { setStartError("Select at least one SO"); return; }
    saveSession(PICKER_NAME_KEY, name);
    setStarting(true);
    try {
      let { resp, data } = await postSession({ force: false });

      // Offer override for locks that were placed but never actually
      // picked (hasScans=false). The backend re-checks this on the
      // force call, so there's no way to clobber real work even if the
      // client raced.
      if (resp.status === 409 && data?.error === "locked" && Array.isArray(data.conflicts)) {
        const releasable = data.conflicts.filter((c) => !c.hasScans);
        const stuck = data.conflicts.filter((c) => c.hasScans);
        if (stuck.length > 0) {
          throw new Error(
            "Some SOs are actively being picked: " +
              stuck.map(describeLock).join("; ") +
              ". Ask that picker to pause or complete first."
          );
        }
        const lines = releasable.map(describeLock).join("\n  • ");
        const ok = confirm(
          `The following SO${releasable.length === 1 ? " is" : "s are"} held by another picker but haven't been scanned yet:\n\n  • ${lines}\n\nOverride and take over?`
        );
        if (!ok) throw new Error("Cancelled");
        ({ resp, data } = await postSession({ force: true }));
      }

      if (!resp.ok) {
        const msg = data?.error === "locked_with_scans"
          ? "Cannot override: " + (data.conflicts || []).map(describeLock).join("; ")
          : data?.conflicts
            ? `Locked: ${data.conflicts.map(describeLock).join("; ")}`
            : data?.error || `API ${resp.status}`;
        throw new Error(msg);
      }
      onStartPick(data);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
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

      <div style={{ padding: "12px 16px 180px" }}>
        <div style={fadeIn}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 10px",
              borderRadius: 20,
              background: `${ACCENT}15`,
              border: `1px solid ${ACCENT}30`,
              fontSize: 11,
              color: ACCENT,
              fontWeight: 600,
              marginBottom: 10,
              ...mono,
            }}
          >
            📍 {location?.name}
          </div>

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

          <div style={{ ...S.card, padding: 12, marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", marginBottom: 4, letterSpacing: 0.3 }}>
              SCAN SO# TO ADD (or tap rows below)
            </label>
            <ScanInput
              onScan={handleScan}
              placeholder="Scan SO#..."
              inputRef={scanInputRef}
            />
          </div>

          {startError && (
            <div style={{ ...S.err, marginBottom: 10 }}>{startError}</div>
          )}

          {loading && (
            <div>
              <PulsingDot color={ACCENT} label="Loading sales orders..." />
            </div>
          )}
          {error && (
            <div style={S.err}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Failed to load</div>
              <div style={{ fontSize: 12 }}>{error}</div>
            </div>
          )}

          {!loading && !error && orders.length === 0 && (
            <div style={{ ...S.card, textAlign: "center", padding: 32 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", marginBottom: 6 }}>
                No pending Sales Orders
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>at {location?.name}</div>
            </div>
          )}

          {!loading && !error && orders.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {orders.map((o) => {
                const picked = selectedIds.has(String(o.id));
                return (
                  <button
                    key={o.id}
                    onClick={() => { toggle(String(o.id)); beepOk(); }}
                    style={{
                      ...S.card,
                      cursor: "pointer",
                      padding: "12px 14px",
                      border: picked ? `2px solid ${ACCENT}` : `1px solid ${ACCENT}25`,
                      background: picked ? `${ACCENT}18` : `${ACCENT}06`,
                      textAlign: "left",
                      touchAction: "manipulation",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        width: 18, height: 18, borderRadius: 4,
                        border: `2px solid ${picked ? ACCENT : "#475569"}`,
                        background: picked ? ACCENT : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 900, color: "#0f172a",
                        flexShrink: 0,
                      }}
                    >
                      {picked ? "✓" : ""}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                          {o.tranId || `#${o.id}`}
                        </span>
                        {o.shopifyOrderNumber && (
                          <span
                            style={{
                              fontSize: 10,
                              color: "#94a3b8",
                              padding: "1px 6px",
                              background: "rgba(148,163,184,0.10)",
                              border: "1px solid rgba(148,163,184,0.25)",
                              borderRadius: 10,
                              ...mono,
                            }}
                            title="Shopify order number — scannable"
                          >
                            #{o.shopifyOrderNumber}
                          </span>
                        )}
                        <LockBadge order={o} />
                      </div>
                      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {o.customerName || "—"}
                      </div>
                      <div style={{ fontSize: 10, color: "#64748b", marginTop: 2, ...mono }}>
                        {formatDate(o.orderDate)} · {o.lineCount != null ? `${o.lineCount} line${o.lineCount === 1 ? "" : "s"}` : "—"} · {o.remainingQty != null ? `${o.remainingQty} qty` : "—"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedCount > 0 && (
        <div
          style={{
            position: "fixed",
            left: 0, right: 0, bottom: 0,
            padding: 12,
            background: "#0b1220",
            borderTop: "1px solid #1e293b",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, color: "#cbd5e1", flex: 1 }}>
            <strong style={{ color: "#e2e8f0" }}>{selectedCount}</strong> SO{selectedCount === 1 ? "" : "s"} selected
          </div>
          <button
            onClick={startPick}
            disabled={starting}
            style={{
              padding: "10px 18px",
              background: ACCENT,
              color: "#0f172a",
              fontSize: 14,
              fontWeight: 700,
              border: "none",
              borderRadius: 6,
              cursor: starting ? "default" : "pointer",
              opacity: starting ? 0.6 : 1,
              touchAction: "manipulation",
            }}
          >
            {starting ? "Starting..." : `Start Pick →`}
          </button>
        </div>
      )}
    </div>
  );
}
