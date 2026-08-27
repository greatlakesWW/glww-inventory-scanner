import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  suiteql, suiteqlAll, beepOk, beepWarn, beepBin,
  S, FONT, ANIMATIONS, mono, fadeIn, Logo, PulsingDot, ScanInput,
  loadSession, saveSession, clearSession,
} from "../shared";
import ItemDetailDrawer from "../components/ItemDetail";
import { groupByClass, shouldAutoExpand } from "./binLookupGrouping";

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
  const [bin, setBin] = useState(null);        // { binId, binNumber } — resolved bin
  const [rows, setRows] = useState([]);        // contents of `bin`
  const [progress, setProgress] = useState(0); // rows loaded so far
  const [flash, setFlash] = useState(null);
  const [expanded, setExpanded] = useState({});   // className -> open?
  const [drawerItemId, setDrawerItemId] = useState(null);
  const scanRef = useRef(null);
  // Bumped on every scan so an in-flight (slow) scan can tell it has been
  // superseded by a newer one and drop its results instead of clobbering
  // the screen. The scanner gun can fire scans faster than suiteqlAll's
  // multi-page round trips resolve, so ordering by "who started" is not
  // safe — only "who is newest" is.
  const scanSeq = useRef(0);

  // Phase is derived, not stored — one source of truth.
  const phase = selectedLocation ? "scan" : "location";

  // ── LOAD LOCATIONS (only when we actually need the picker) ──
  useEffect(() => {
    if (selectedLocation || locations.length > 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const locs = await suiteql(`SELECT id, name FROM location WHERE isinactive = 'F' ORDER BY name`);
        if (!cancelled) setLocations(locs);
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
    setError(null); setBin(null); setRows([]); setProgress(0);
  }, []);

  const changeLocation = useCallback(() => {
    setSelectedLocation(null);
    clearSession(SESSION_KEY);
    setError(null); setBin(null); setRows([]); setProgress(0);
  }, []);

  const groups = useMemo(() => groupByClass(rows), [rows]);
  const totalUnits = useMemo(
    () => rows.reduce((sum, r) => sum + (Number(r.qty_on_hand) || 0), 0),
    [rows]
  );

  // Reseed the open/closed state whenever a new bin's contents land.
  useEffect(() => {
    const open = shouldAutoExpand(rows.length);
    setExpanded(Object.fromEntries(groups.map(g => [g.className, open])));
  }, [groups, rows.length]);

  const toggleGroup = useCallback((className) => {
    setExpanded(prev => ({ ...prev, [className]: !prev[className] }));
  }, []);

  const doFlash = (type) => { setFlash(type); setTimeout(() => setFlash(null), 400); };

  // ── SCAN A BIN ──
  // Two calls: resolve the bin (so "missing" and "empty" stay
  // distinguishable), then page in its contents by internal ID.
  const handleBinScan = useCallback(async (val) => {
    const trimmed = val.trim();
    if (!trimmed || !selectedLocation) return;
    const seq = ++scanSeq.current;

    setError(null); setBin(null); setRows([]); setProgress(0); setLoading(true);

    try {
      const resp = await fetch(
        `/api/bins/validate?locationId=${encodeURIComponent(selectedLocation.id)}` +
        `&binNumber=${encodeURIComponent(trimmed)}`
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `API error ${resp.status}`);
      if (seq !== scanSeq.current) return; // superseded by a newer scan

      if (!data.valid) {
        beepWarn(); doFlash("warn");
        setError(`Bin "${trimmed}" doesn't exist at ${selectedLocation.name}`);
        return;
      }

      // suiteqlAll, not suiteql: catch-all Sales Floor bins run to
      // thousands of SKUs and the 1000-row default would silently
      // drop everything past the cutoff.
      const contents = await suiteqlAll(`
        SELECT
          ib.item AS item_id,
          item.itemid AS sku,
          item.displayname AS item_name,
          BUILTIN.DF(item.class) AS class_name,
          ib.quantityonhand AS qty_on_hand,
          ib.quantityavailable AS qty_available
        FROM inventorybalance ib
        JOIN item ON ib.item = item.id
        WHERE ib.binnumber = ${Number(data.binId)}
          AND ib.location = ${Number(selectedLocation.id)}
          AND ib.quantityonhand > 0
        ORDER BY BUILTIN.DF(item.class), item.itemid
      `, (loaded) => { if (seq === scanSeq.current) setProgress(loaded); });
      if (seq !== scanSeq.current) return; // superseded by a newer scan

      setBin({ binId: data.binId, binNumber: data.binNumber });
      setRows(contents);

      if (contents.length === 0) { beepOk(); doFlash("ok"); }
      else { beepBin(); doFlash("bin"); }
    } catch (e) {
      if (seq !== scanSeq.current) return; // superseded by a newer scan
      beepWarn(); doFlash("warn");
      setBin(null); setRows([]);
      setError(`Bin lookup failed: ${e.message}`);
    } finally {
      if (seq === scanSeq.current) setLoading(false);
    }
  }, [selectedLocation]);

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
              <ScanInput inputRef={scanRef} onScan={handleBinScan} placeholder="Scan bin..." flash={flash} />
              {loading && (
                <PulsingDot
                  color={ACCENT}
                  label={progress > 0 ? `Loaded ${progress.toLocaleString()} items…` : "Looking up bin…"}
                />
              )}
            </div>

            {error && <div style={S.err}>{error}</div>}

            {bin && rows.length === 0 && (
              <div style={{
                ...S.card, textAlign: "center", padding: 20,
                background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, ...mono, color: "#fbbf24" }}>{bin.binNumber}</div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 6 }}>
                  This bin is empty — 0 SKUs, 0 units.
                </div>
              </div>
            )}

            {bin && rows.length > 0 && (
              <div style={fadeIn}>
                {/* Stat strip */}
                <div style={{
                  ...S.card, padding: "12px 16px", marginBottom: 10,
                  background: `${ACCENT}0f`, border: `1px solid ${ACCENT}40`,
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, ...mono, color: "#5eead4" }}>{bin.binNumber}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{selectedLocation.name}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, ...mono, color: "#e2e8f0" }}>
                      {rows.length.toLocaleString()} SKUs
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, ...mono, color: "#22c55e" }}>
                      {totalUnits.toLocaleString()} units
                    </div>
                  </div>
                </div>

                {/* Class groups */}
                {groups.map(group => {
                  const isOpen = !!expanded[group.className];
                  return (
                    <div key={group.className} style={{
                      borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)",
                      background: "rgba(255,255,255,0.03)", marginBottom: 8, overflow: "hidden",
                    }}>
                      <button
                        onClick={() => toggleGroup(group.className)}
                        style={{
                          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "12px 14px", background: "transparent", border: "none",
                          cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                          touchAction: "manipulation", minHeight: 48,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span style={{ color: "#475569", fontSize: 12 }}>{isOpen ? "▾" : "▸"}</span>
                          <span style={{
                            fontSize: 14, fontWeight: 700, color: "#e2e8f0",
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          }}>{group.className}</span>
                        </div>
                        <span style={{ fontSize: 11, color: "#94a3b8", ...mono, flexShrink: 0, marginLeft: 8 }}>
                          {group.skuCount} · {group.unitCount.toLocaleString()}u
                        </span>
                      </button>

                      {isOpen && group.items.map((r, i) => (
                        <div
                          key={r.item_id}
                          onClick={() => setDrawerItemId(r.item_id)}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            padding: "10px 14px", cursor: "pointer", touchAction: "manipulation",
                            borderTop: "1px solid rgba(255,255,255,0.04)",
                            background: i % 2 ? "rgba(255,255,255,0.01)" : "transparent",
                            minHeight: 48,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, ...mono, color: "#e2e8f0" }}>{r.sku}</div>
                            <div style={{
                              fontSize: 11, color: "#64748b",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>{r.item_name}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginLeft: 12, flexShrink: 0 }}>
                            <span style={{ fontSize: 15, fontWeight: 700, ...mono, color: "#cbd5e1" }}>{r.qty_on_hand}</span>
                            {Number(r.qty_available) !== Number(r.qty_on_hand) && (
                              <span style={{ fontSize: 11, color: "#64748b", ...mono }}>({r.qty_available} avail)</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            <button onClick={changeLocation} style={S.btnSec}>Change Location</button>
          </div>
        )}
      </div>

      <ItemDetailDrawer
        itemId={drawerItemId}
        onClose={() => setDrawerItemId(null)}
        refocusRef={scanRef}
      />
    </div>
  );
}
