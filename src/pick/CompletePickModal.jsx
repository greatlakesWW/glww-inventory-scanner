import { useMemo } from "react";
import { S, mono } from "../shared";

// ═══════════════════════════════════════════════════════════
// CompletePickModal — confirmation before POST /api/.../fulfill
//
// Per spec §2 step 10: "Confirmation modal: shows qty picked vs ordered
// per line, flags any partial lines."
//
// Props:
//   detail        — GET /api/transfer-orders/:id response (has lines[])
//   pickedByLine  — { [lineId]: qty } from usePickSession
//   busy          — disables Confirm while fulfill POST is in flight
//   error         — transient string to surface below the summary
//   onConfirm()   — fires hook.completeFulfill()
//   onCancel()    — closes modal without firing
// ═══════════════════════════════════════════════════════════

const ACCENT = "#6366f1";
const GREEN = "#22c55e";
const AMBER = "#f59e0b";

export default function CompletePickModal({
  detail,
  pickedByLine,
  busy,
  error,
  onConfirm,
  onCancel,
}) {
  const rows = useMemo(() => {
    if (!detail?.lines) return [];
    return detail.lines.map((line) => {
      const ordered = Number(line.qtyRemaining) || 0;
      const picked = Number(pickedByLine[String(line.lineId)] || 0);
      const state =
        picked === 0
          ? "empty"
          : picked >= ordered
          ? "full"
          : "partial";
      return {
        lineId: line.lineId,
        sku: line.sku,
        description: line.description,
        ordered,
        picked,
        state,
      };
    });
  }, [detail, pickedByLine]);

  const totals = useMemo(() => {
    const tp = rows.reduce((a, r) => a + r.picked, 0);
    const to = rows.reduce((a, r) => a + r.ordered, 0);
    const fullLines = rows.filter((r) => r.state === "full").length;
    const partial = rows.filter((r) => r.state === "partial").length;
    const empty = rows.filter((r) => r.state === "empty").length;
    return { totalPicked: tp, totalOrdered: to, fullLines, partial, empty };
  }, [rows]);

  const nothingPicked = totals.totalPicked === 0;
  const hasPartialOrUntouched = totals.partial + totals.empty > 0;

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
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        style={{
          ...S.card,
          background: "#111827", // solid — matches app header, no show-through
          maxWidth: 560,
          width: "100%",
          padding: 0,
          zIndex: 910,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 20px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: ACCENT,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              fontWeight: 700,
              marginBottom: 6,
            }}
          >
            Complete Pick
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>
            Review & confirm fulfillment
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
            Creates an Item Fulfillment + Item Receipt in NetSuite. Stock moves
            from source bins into the salesfloor bin.
          </div>
        </div>

        {/* Scrollable line list */}
        <div
          style={{
            overflowY: "auto",
            padding: "6px 0",
            flex: 1,
          }}
        >
          {rows.map((r) => (
            <div
              key={r.lineId}
              style={{
                padding: "8px 20px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                opacity: r.state === "empty" ? 0.55 : 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#e2e8f0",
                    ...mono,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.sku}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "#94a3b8",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.description || ""}
                </div>
              </div>
              <StateChip state={r.state} />
              <div
                style={{
                  minWidth: 64,
                  textAlign: "right",
                  fontSize: 13,
                  fontWeight: 700,
                  ...mono,
                  color:
                    r.state === "full"
                      ? GREEN
                      : r.state === "partial"
                      ? AMBER
                      : "#475569",
                }}
              >
                {r.picked}/{r.ordered}
              </div>
            </div>
          ))}
        </div>

        {/* Footer summary + actions */}
        <div
          style={{
            padding: "14px 20px 18px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12,
              color: "#94a3b8",
              marginBottom: 10,
              ...mono,
            }}
          >
            <span>
              Lines:{" "}
              <span style={{ color: GREEN }}>{totals.fullLines}</span> full ·{" "}
              <span style={{ color: AMBER }}>{totals.partial}</span> partial ·{" "}
              <span style={{ color: "#64748b" }}>{totals.empty}</span> untouched
            </span>
            <span>
              Units: <span style={{ color: "#e2e8f0" }}>{totals.totalPicked}</span>
              <span style={{ color: "#64748b" }}> / {totals.totalOrdered}</span>
            </span>
          </div>

          {nothingPicked && (
            <div
              style={{
                fontSize: 12,
                color: AMBER,
                padding: "8px 10px",
                marginBottom: 10,
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.3)",
                borderRadius: 6,
              }}
            >
              Scan at least one item before completing.
            </div>
          )}

          {!nothingPicked && hasPartialOrUntouched && (
            <div
              style={{
                fontSize: 12,
                color: AMBER,
                padding: "8px 10px",
                marginBottom: 10,
                background: "rgba(245,158,11,0.08)",
                border: "1px solid rgba(245,158,11,0.3)",
                borderRadius: 6,
              }}
            >
              The TO will stay open for the {totals.partial + totals.empty} remaining line
              {totals.partial + totals.empty === 1 ? "" : "s"}. You (or another picker) can
              finish it later.
            </div>
          )}

          {error && <div style={{ ...S.err, marginBottom: 10 }}>{error}</div>}

          <button
            onClick={onConfirm}
            disabled={busy || nothingPicked}
            style={{
              ...S.btn,
              background: GREEN,
              marginBottom: 8,
              opacity: busy || nothingPicked ? 0.5 : 1,
              cursor: busy || nothingPicked ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Submitting…" : "Confirm — create fulfillment + receipt"}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{ ...S.btnSec, opacity: busy ? 0.5 : 1 }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function StateChip({ state }) {
  const style = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    ...mono,
  };
  if (state === "full") {
    return (
      <span
        style={{
          ...style,
          color: GREEN,
          background: "rgba(34,197,94,0.12)",
          border: "1px solid rgba(34,197,94,0.35)",
        }}
      >
        ✓ Full
      </span>
    );
  }
  if (state === "partial") {
    return (
      <span
        style={{
          ...style,
          color: AMBER,
          background: "rgba(245,158,11,0.12)",
          border: "1px solid rgba(245,158,11,0.35)",
        }}
      >
        ⚠ Partial
      </span>
    );
  }
  return (
    <span
      style={{
        ...style,
        color: "#64748b",
        background: "rgba(148,163,184,0.08)",
        border: "1px solid rgba(148,163,184,0.2)",
      }}
    >
      — None
    </span>
  );
}
