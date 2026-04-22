import { useEffect, useState } from "react";
import { S, FONT, ANIMATIONS, mono, Logo, PulsingDot, fadeIn } from "../shared";

// ═══════════════════════════════════════════════════════════
// TOListScreen
//
// Step 2 of Pick Mode — lists open outbound Transfer Orders at
// the selected source location. Data comes from
// GET /api/transfer-orders?location={id} (Session 2 endpoint).
//
// Tapping a TO transitions to the Pick Screen (stub in Session 3,
// real UI in Session 4).
//
// Props:
//   location — { id, name } chosen upstream
//   onSelect(to) — invoked when a TO row is tapped
//   onBack()     — header Back (returns to LocationPicker)
// ═══════════════════════════════════════════════════════════

const ACCENT = "#6366f1";

// Thresholds from spec §6.3
const LOCK_FRESH_MS = 30 * 60 * 1000;   // 30 min — muted badge
const LOCK_STALE_MS = 4 * 60 * 60 * 1000; // 4 hr  — treat as abandoned

function formatDate(iso) {
  if (!iso) return "";
  // iso may be "2026-04-20" or ISO datetime. Keep just the date portion for list view.
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
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function StatusBadge({ to }) {
  // Compute effective lock state (spec §6.3)
  const lockedBy = to.lockedBy;
  const lockedAt = to.lockedAt;
  const ageMs = lockedAt ? Date.now() - new Date(lockedAt).getTime() : Infinity;
  const treatAsAvailable = !lockedBy || ageMs >= LOCK_STALE_MS;

  if (treatAsAvailable) {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "3px 10px",
          borderRadius: 20,
          background: "rgba(59,130,246,0.12)",
          border: "1px solid rgba(59,130,246,0.35)",
          color: "#60a5fa",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          ...mono,
        }}
      >
        Available
      </span>
    );
  }

  const isFresh = ageMs < LOCK_FRESH_MS;
  const bg = isFresh ? "rgba(148,163,184,0.12)" : "rgba(245,158,11,0.12)";
  const bc = isFresh ? "rgba(148,163,184,0.35)" : "rgba(245,158,11,0.35)";
  const fg = isFresh ? "#94a3b8" : "#f59e0b";
  const prefix = isFresh ? "In Progress" : "Stale";

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 2,
      }}
    >
      <span
        style={{
          display: "inline-block",
          padding: "3px 10px",
          borderRadius: 20,
          background: bg,
          border: `1px solid ${bc}`,
          color: fg,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          ...mono,
        }}
      >
        {prefix} · {lockedBy}
      </span>
      <span style={{ fontSize: 10, color: "#64748b" }}>{formatRelative(lockedAt)}</span>
    </div>
  );
}

export default function TOListScreen({ location, onSelect, onBack }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!location?.id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch(`/api/transfer-orders?location=${encodeURIComponent(location.id)}`);
        const data = await resp.json();
        if (!resp.ok) {
          throw new Error(data?.error || `API error ${resp.status}`);
        }
        if (!cancelled) setOrders(Array.isArray(data.orders) ? data.orders : []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load transfer orders");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location?.id]);

  const LocationBadge = () => location ? (
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
        ...mono,
      }}
    >
      📍 {location.name}
    </div>
  ) : null;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>
            Pick Transfer Orders
          </span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      <div style={{ padding: "16px 16px 120px" }}>
        <div style={fadeIn}>
          <div style={{ marginBottom: 12 }}><LocationBadge /></div>

          {loading && (
            <div>
              <PulsingDot color={ACCENT} label="Loading transfer orders..." />
              <div style={{ textAlign: "center", fontSize: 11, color: "#64748b", marginTop: 8 }}>
                This may take a few seconds.
              </div>
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
                No open Transfer Orders
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>
                at {location?.name}
              </div>
            </div>
          )}

          {!loading && !error && orders.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {orders.map((to) => (
                <button
                  key={to.id}
                  onClick={() => onSelect(to)}
                  style={{
                    ...S.card,
                    cursor: "pointer",
                    padding: "14px 16px",
                    border: `1px solid ${ACCENT}25`,
                    background: `${ACCENT}06`,
                    textAlign: "left",
                    touchAction: "manipulation",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                      {to.tranId || `#${to.id}`}
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                      → {to.destinationLocationName || "—"}
                    </div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2, ...mono }}>
                      {formatDate(to.orderDate)}
                    </div>
                  </div>
                  <StatusBadge to={to} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
