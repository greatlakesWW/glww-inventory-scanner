import { useEffect, useState } from "react";
import { S, FONT, ANIMATIONS, mono, Logo, PulsingDot, fadeIn } from "../shared";

// ═══════════════════════════════════════════════════════════
// PickScreenStub
//
// Intentional placeholder for Session 3. Proves the tap-through
// from TOListScreen works and exercises the detail endpoint from
// Session 2. Session 4 will replace this with the real pick UI
// (bin scan + item scan loop backed by /api/pick-sessions).
//
// Props:
//   toId    — internal ID string
//   tranId  — human-readable TO number for the header
//   onBack() — returns to TO list
// ═══════════════════════════════════════════════════════════

const ACCENT = "#6366f1";

export default function PickScreenStub({ toId, tranId, onBack }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!toId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const resp = await fetch(`/api/transfer-orders/${encodeURIComponent(toId)}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `API error ${resp.status}`);
        if (!cancelled) setDetail(data);
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load TO detail");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toId]);

  const pendingLines = detail?.lines?.filter((l) => Number(l.qtyRemaining) > 0).length ?? 0;
  const totalLines = detail?.lines?.length ?? 0;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3, ...mono }}>
            Pick: {tranId || `#${toId}`}
          </span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      <div style={{ padding: "16px 16px 120px" }}>
        <div style={fadeIn}>
          {loading && <PulsingDot color={ACCENT} label="Loading TO detail..." />}

          {error && <div style={S.err}>{error}</div>}

          {!loading && !error && detail && (
            <>
              {/* From → To card */}
              <div style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={S.lbl}>From</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                      {detail.sourceLocationName || "—"}
                    </div>
                  </div>
                  <div style={{ fontSize: 22, color: "#475569" }}>→</div>
                  <div style={{ textAlign: "right" }}>
                    <div style={S.lbl}>To</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: ACCENT, ...mono }}>
                      {detail.destinationLocationName || "—"}
                    </div>
                  </div>
                </div>
              </div>

              {/* Line summary */}
              <div style={S.card}>
                <div style={S.lbl}>Lines</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                    {pendingLines}
                    <span style={{ fontSize: 14, color: "#64748b", fontWeight: 500 }}>
                      {" "}/ {totalLines}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>
                    {pendingLines === 0 ? "All lines fulfilled" : `${pendingLines} to pick`}
                  </div>
                </div>
              </div>

              {/* Session 4 placeholder */}
              <div
                style={{
                  ...S.card,
                  background: "rgba(99,102,241,0.08)",
                  border: "1px dashed rgba(99,102,241,0.35)",
                  textAlign: "center",
                  padding: 28,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: ACCENT, marginBottom: 6 }}>
                  Pick Screen — Session 4
                </div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>
                  Bin scan and item scan flow lands in the next session. The TO detail
                  is already fetched (see above), so the data is ready.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
