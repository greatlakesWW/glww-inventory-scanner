import { S, mono } from "../shared";

// ═══════════════════════════════════════════════════════════
// TakeoverModal — spec §6.3 soft-lock takeover UI
//
// Rendered when POST /api/pick-sessions returned 409 because
// another picker already owns the session. The primary action
// button's prominence scales with how stale the lock is:
//   < 30 min   — muted "Take Over Anyway"
//   30m..4h    — amber prominent "Take Over"
//   >= 4h      — shouldn't land here (list auto-releases), but
//                we still render a prominent button as a fallback.
//
// Props:
//   lockedBy    — display name of the current owner
//   lockedAt    — ISO timestamp of last activity
//   busy        — disables both actions while a PATCH is in flight
//   onTakeOver() — confirm
//   onCancel()   — dismiss, return to TO list
// ═══════════════════════════════════════════════════════════

const FRESH_MS = 30 * 60 * 1000;
const STALE_MS = 4 * 60 * 60 * 1000;

function formatRelative(iso) {
  if (!iso) return "just now";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function TakeoverModal({ lockedBy, lockedAt, busy, onTakeOver, onCancel }) {
  const ageMs = lockedAt ? Date.now() - Date.parse(lockedAt) : Infinity;
  const isFresh = Number.isFinite(ageMs) && ageMs < FRESH_MS;
  const isStale = !Number.isFinite(ageMs) || ageMs >= STALE_MS;

  // Primary-button styling varies by age per §6.3
  const takeOverStyle = isFresh
    ? {
        ...S.btnSec,
        color: "#94a3b8",
        borderColor: "rgba(148,163,184,0.3)",
      }
    : {
        ...S.btn,
        background: isStale ? "#ef4444" : "#f59e0b",
      };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 900,
        padding: 16,
      }}
      onClick={(e) => {
        // Click-outside = cancel, matching native modal behavior.
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        style={{
          ...S.card,
          maxWidth: 420,
          width: "100%",
          padding: 24,
          zIndex: 910,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#f59e0b",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 700,
            marginBottom: 8,
          }}
        >
          Already in Progress
        </div>

        <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0", marginBottom: 6 }}>
          {lockedBy || "Another picker"} is picking this TO
        </div>

        <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 4 }}>
          Last activity: <span style={mono}>{formatRelative(lockedAt)}</span>
        </div>

        {isStale && (
          <div
            style={{
              fontSize: 12,
              color: "#ef4444",
              marginTop: 8,
              padding: "8px 10px",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
            }}
          >
            Session is stale — likely abandoned. Safe to take over.
          </div>
        )}

        {isFresh && (
          <div
            style={{
              fontSize: 12,
              color: "#64748b",
              marginTop: 8,
              padding: "8px 10px",
              background: "rgba(148,163,184,0.08)",
              border: "1px solid rgba(148,163,184,0.2)",
              borderRadius: 6,
            }}
          >
            Confirm with {lockedBy} before taking over — they're still actively picking.
          </div>
        )}

        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            onClick={onTakeOver}
            disabled={busy}
            style={{ ...takeOverStyle, opacity: busy ? 0.5 : 1 }}
          >
            {busy ? "Taking over…" : isFresh ? "Take Over Anyway" : "Take Over"}
          </button>
          <button onClick={onCancel} disabled={busy} style={{ ...S.btnSec, opacity: busy ? 0.5 : 1 }}>
            Back to TO List
          </button>
        </div>
      </div>
    </div>
  );
}
