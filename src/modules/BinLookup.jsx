import { useState, useEffect, useCallback, useRef } from "react";
import {
  suiteql,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo, PulsingDot, ScanInput,
  loadSession, saveSession, clearSession,
} from "../shared";

// ═══════════════════════════════════════════════════════════
// BIN LOOKUP MODULE — read-only "what's in this bin?"
//
// Two phases. Location first, because bin numbers are only unique
// per location. The location sticks in localStorage so a returning
// employee lands straight on the scan screen.
// ═══════════════════════════════════════════════════════════

const ACCENT = "#14b8a6";
const SESSION_KEY = "glww_bin_lookup";

export default function BinLookup({ onBack }) {
  const [selectedLocation, setSelectedLocation] = useState(
    () => loadSession(SESSION_KEY)?.location || null
  );
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const scanRef = useRef(null);

  // Phase is derived, not stored — one source of truth.
  const phase = selectedLocation ? "scan" : "location";

  // ── LOAD LOCATIONS (only when we actually need the picker) ──
  useEffect(() => {
    if (selectedLocation || locations.length > 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await suiteql(`SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name`);
        if (!cancelled) setLocations(rows);
      } catch (e) {
        if (!cancelled) setError(`Failed to load locations: ${e.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedLocation, locations.length]);

  const selectLocation = useCallback((loc) => {
    setSelectedLocation(loc);
    saveSession(SESSION_KEY, { location: loc });
    setError(null);
  }, []);

  const changeLocation = useCallback(() => {
    setSelectedLocation(null);
    clearSession(SESSION_KEY);
    setError(null);
  }, []);

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      {/* ════════════ HEADER ════════════ */}
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>Bin Lookup</span>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Home</button>
      </div>

      <div style={{ padding: "16px 16px 40px" }}>

        {/* ════════════ PHASE 1 — SELECT LOCATION ════════════ */}
        {phase === "location" && (
          <div style={fadeIn}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Select Location</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>Bin numbers repeat across locations</div>
            </div>

            {loading && <PulsingDot color={ACCENT} label="Loading locations..." />}
            {error && <div style={S.err}>{error}</div>}

            {!loading && locations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {locations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => selectLocation(loc)}
                    style={{
                      ...S.card, cursor: "pointer", padding: "14px 16px", marginBottom: 0,
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      border: `1px solid ${ACCENT}25`, background: `${ACCENT}06`,
                      fontFamily: "inherit", transition: "all 0.15s", touchAction: "manipulation",
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{loc.name}</span>
                    <span style={{ color: "#475569", fontSize: 16 }}>›</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════ PHASE 2 — SCAN BIN ════════════ */}
        {phase === "scan" && (
          <div style={fadeIn}>
            <div style={{
              ...S.card, textAlign: "center", padding: 20, marginBottom: 12,
              border: `2px solid ${ACCENT}4d`, background: `${ACCENT}0a`,
            }}>
              <div style={{
                fontSize: 12, color: ACCENT, textTransform: "uppercase",
                letterSpacing: 1, fontWeight: 700, marginBottom: 10,
              }}>
                Scan Bin · {selectedLocation.name}
              </div>
              <ScanInput inputRef={scanRef} onScan={() => {}} placeholder="Scan bin..." />
            </div>

            {error && <div style={S.err}>{error}</div>}

            <button onClick={changeLocation} style={S.btnSec}>Change Location</button>
          </div>
        )}
      </div>
    </div>
  );
}
