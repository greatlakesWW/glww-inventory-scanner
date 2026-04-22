import { useEffect, useState } from "react";
import { suiteql, S, FONT, ANIMATIONS, Logo, PulsingDot, fadeIn } from "../shared";

// ═══════════════════════════════════════════════════════════
// LocationPicker
//
// Step 1 of Pick Mode — user selects the source location whose
// open Transfer Orders they want to pick. Mirrors the location
// phase in BinTransfer / CreateInventory but standalone so it
// can be the first screen of the Pick picker flow.
//
// Props:
//   onSelect(loc) — invoked when a location is tapped. loc = {id, name}
//   onBack()      — invoked when header Back is tapped (returns to Home)
// ═══════════════════════════════════════════════════════════

const ACCENT = "#6366f1"; // indigo — matches the Home tile

export default function LocationPicker({ onSelect, onBack }) {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await suiteql(
          "SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name"
        );
        if (!cancelled) setLocations(rows);
      } catch (e) {
        if (!cancelled) setError(`Failed to load locations: ${e.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
              Select Source Location
            </div>
            <div style={{ fontSize: 13, color: "#64748b" }}>
              Choose the location whose TOs you want to pick
            </div>
          </div>

          {loading && <PulsingDot color={ACCENT} label="Loading locations..." />}
          {error && <div style={S.err}>{error}</div>}

          {!loading && !error && locations.length === 0 && (
            <div style={{ ...S.card, textAlign: "center", color: "#94a3b8" }}>
              No active locations found.
            </div>
          )}

          {!loading && locations.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {locations.map((loc) => (
                <button
                  key={loc.id}
                  onClick={() => onSelect(loc)}
                  style={{
                    ...S.card,
                    cursor: "pointer",
                    padding: "14px 16px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    border: `1px solid ${ACCENT}25`,
                    background: `${ACCENT}06`,
                    transition: "all 0.15s",
                    touchAction: "manipulation",
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>
                    {loc.name}
                  </span>
                  <span style={{ color: "#475569", fontSize: 16 }}>›</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
