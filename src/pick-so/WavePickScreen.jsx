import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  S, FONT, ANIMATIONS, mono, Logo, PulsingDot, fadeIn,
  ScanInput, useScanRefocus, beepOk, beepWarn, beepBin, beepExtra,
} from "../shared";
import useWavePickSession from "./useWavePickSession";

// ═══════════════════════════════════════════════════════════
// WavePickScreen
//
// Aggregated pick across the selected wave of SOs. The picker
// scans a bin, then scans items. Each scan records an event on
// the backend session; allocation to individual SOs happens at
// fulfill time (oldest SO first).
//
// Wave totals derive from each SO's detail endpoint —
// `qtyRemaining` per line is summed by itemId. Lines are
// displayed in warehouse-walk order (lowest bin first).
// ═══════════════════════════════════════════════════════════

const ACCENT = "#22c55e";
const WARN   = "#f59e0b";
const ERR    = "#ef4444";

function primaryBin(line) {
  const b = line?.binAvailability?.[0]?.binNumber;
  return b ? String(b).toUpperCase() : "\uffff";
}

export default function WavePickScreen({ wave, location, onComplete, onBack }) {
  const {
    session, recordScan, removeSO, markUnavailable, undoUnavailable, complete,
  } = useWavePickSession(wave);

  const [detailBySO, setDetailBySO] = useState({});
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [currentBin, setCurrentBin] = useState(null); // { binId, binNumber }
  const [flash, setFlash] = useState(null);
  const [banner, setBanner] = useState(null); // { kind: "ok"|"warn"|"err", text }
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState(null); // { status, results:[...], waveShortages:[] }
  const [manageOpen, setManageOpen] = useState(false);
  const [removingSOId, setRemovingSOId] = useState(null);

  const binScanRef = useRef(null);
  const itemScanRef = useRef(null);

  // Load detail for each SO in the wave. Re-runs when soIds changes
  // (flex-add case). Per-SO fetch is done with the location hint.
  useEffect(() => {
    if (!session?.soIds?.length || !location?.id) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    (async () => {
      const missing = session.soIds.filter((sid) => !detailBySO[sid]);
      if (missing.length === 0) {
        setDetailLoading(false);
        return;
      }
      try {
        const fetched = await Promise.all(
          missing.map(async (sid) => {
            const r = await fetch(
              `/api/sales-orders/${encodeURIComponent(sid)}?location=${encodeURIComponent(location.id)}`
            );
            const d = await r.json();
            if (!r.ok) throw new Error(d?.error || `SO ${sid} fetch failed`);
            return [sid, d];
          })
        );
        if (cancelled) return;
        setDetailBySO((prev) => {
          const next = { ...prev };
          for (const [sid, d] of fetched) next[sid] = d;
          return next;
        });
      } catch (e) {
        if (!cancelled) setDetailError(e.message);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.soIds?.join(","), location?.id]);

  // ─── Derived aggregates ───────────────────────────────────────
  const agg = useMemo(() => {
    const needByItemId = {};           // itemId -> total needed across wave
    const metaByItemId = {};           // itemId -> { sku, description, upc, bins:[{binId,binNumber}] }
    const upcToItemId = {};            // exact UPC string -> itemId
    const skuToItemId = {};            // upper SKU -> itemId
    const binByNumber = {};            // bin name UPPER -> { binId, binNumber }
    const binPlan = {};                // bin name UPPER -> Set<itemId> available there

    for (const so of Object.values(detailBySO)) {
      for (const line of so?.lines || []) {
        const iid = line.itemId;
        if (!iid) continue;
        needByItemId[iid] = (needByItemId[iid] || 0) + (Number(line.qtyRemaining) || 0);
        if (!metaByItemId[iid]) {
          metaByItemId[iid] = {
            sku: line.sku || null,
            description: line.description || null,
            upc: line.upc || null,
            bins: [...(line.binAvailability || [])],
          };
        } else {
          // Merge bin availability if some SOs see it at different bins
          const seen = new Set(metaByItemId[iid].bins.map((b) => b.binId));
          for (const b of line.binAvailability || []) {
            if (!seen.has(b.binId)) metaByItemId[iid].bins.push(b);
          }
        }
        if (line.upc) upcToItemId[String(line.upc)] = iid;
        if (line.sku) skuToItemId[String(line.sku).toUpperCase()] = iid;
        for (const b of line.binAvailability || []) {
          const key = String(b.binNumber || "").toUpperCase();
          if (!key) continue;
          if (!binByNumber[key]) binByNumber[key] = { binId: b.binId, binNumber: b.binNumber };
          if (!binPlan[key]) binPlan[key] = new Set();
          binPlan[key].add(iid);
        }
      }
    }

    return { needByItemId, metaByItemId, upcToItemId, skuToItemId, binByNumber, binPlan };
  }, [detailBySO]);

  const pickedByItemId = useMemo(() => {
    const m = {};
    for (const ev of session?.events || []) {
      if (!ev || ev.type !== "scan") continue;
      const iid = String(ev.itemId || "");
      const q = Number(ev.qty) || 0;
      if (iid && q) m[iid] = (m[iid] || 0) + q;
    }
    return m;
  }, [session?.events]);

  const unavailableItemIds = useMemo(() => {
    // Latest-wins: mark_unavailable / undo_unavailable events applied in order.
    const set = new Set();
    for (const ev of session?.events || []) {
      if (!ev) continue;
      if (ev.type === "mark_unavailable") set.add(String(ev.itemId));
      else if (ev.type === "undo_unavailable") set.delete(String(ev.itemId));
    }
    return set;
  }, [session?.events]);

  const sortedItems = useMemo(() => {
    const rows = Object.entries(agg.needByItemId).map(([iid, need]) => {
      const meta = agg.metaByItemId[iid] || {};
      const picked = pickedByItemId[iid] || 0;
      const unavailable = unavailableItemIds.has(iid);
      const bins = [...(meta.bins || [])].sort((a, b) =>
        String(a.binNumber).toUpperCase().localeCompare(String(b.binNumber).toUpperCase())
      );
      return { itemId: iid, need, picked, unavailable, meta, primary: primaryBin({ binAvailability: bins }), bins };
    });
    const binKey = currentBin?.binNumber ? currentBin.binNumber.toUpperCase() : null;
    const itemsInBin = binKey ? agg.binPlan[binKey] : null;
    // Sort: active (not done, not unavailable) first — then unavailable
    // and fully-picked items sink to the bottom.
    rows.sort((a, b) => {
      const restA = a.picked >= a.need || a.unavailable;
      const restB = b.picked >= b.need || b.unavailable;
      if (restA !== restB) return restA ? 1 : -1;
      if (itemsInBin) {
        const inA = itemsInBin.has(a.itemId);
        const inB = itemsInBin.has(b.itemId);
        if (inA !== inB) return inA ? -1 : 1;
      }
      if (a.primary !== b.primary) return a.primary < b.primary ? -1 : 1;
      return 0;
    });
    return rows;
  }, [agg, pickedByItemId, unavailableItemIds, currentBin]);

  const totalNeed = useMemo(
    () => Object.values(agg.needByItemId).reduce((s, n) => s + n, 0),
    [agg.needByItemId]
  );
  const totalPicked = useMemo(
    () => Object.values(pickedByItemId).reduce((s, n) => s + n, 0),
    [pickedByItemId]
  );
  // Pending = rows the picker hasn't yet resolved (neither fully picked
  // nor flagged unavailable). When pending is zero, the wave is
  // considered "done" — either everything was picked or the missing
  // pieces were explicitly sent to admin for customer follow-up.
  const pendingRows = useMemo(
    () => sortedItems.filter((r) => r.picked < r.need && !r.unavailable).length,
    [sortedItems]
  );

  // ─── Flash helpers ────────────────────────────────────────────
  const bannerTimerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const showBanner = useCallback((kind, text, ms = 2500) => {
    setBanner({ kind, text });
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setBanner(null), ms);
  }, []);
  const doFlash = useCallback((kind) => {
    setFlash(kind);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 250);
  }, []);

  // ─── Scan handlers ────────────────────────────────────────────
  const handleBinScan = useCallback((raw) => {
    const val = String(raw || "").trim();
    if (!val) return;
    const key = val.toUpperCase();
    const hit = agg.binByNumber[key];
    if (!hit) {
      beepWarn(); doFlash("warn"); showBanner("warn", `Bin "${val}" has none of the wave's items`);
      return;
    }
    setCurrentBin(hit);
    beepBin(); doFlash("bin");
    showBanner("ok", `Bin ${hit.binNumber}`, 1500);
  }, [agg.binByNumber, doFlash, showBanner]);

  const handleItemScan = useCallback(async (raw) => {
    const val = String(raw || "").trim();
    if (!val) return;
    if (!currentBin) {
      beepWarn(); doFlash("warn"); showBanner("warn", "Scan a bin first");
      return;
    }
    const iid =
      agg.upcToItemId[val] ||
      agg.skuToItemId[val.toUpperCase()] ||
      null;
    if (!iid) {
      beepWarn(); doFlash("warn"); showBanner("warn", "Item not on any wave SO");
      return;
    }
    const need = agg.needByItemId[iid] || 0;
    const picked = pickedByItemId[iid] || 0;
    if (picked >= need) {
      beepExtra(); doFlash("warn");
      showBanner("warn", `Already picked ${picked}/${need} of this item`);
      return;
    }
    const binKey = currentBin.binNumber.toUpperCase();
    const availHere = agg.binPlan[binKey];
    if (availHere && !availHere.has(iid)) {
      beepWarn(); doFlash("warn");
      showBanner("warn", `Item isn't stocked in ${currentBin.binNumber}`);
      return;
    }
    try {
      await recordScan({ itemId: iid, binId: currentBin.binId, qty: 1 });
      beepOk(); doFlash("ok");
      showBanner("ok", `+1 picked`, 1200);
    } catch (e) {
      beepWarn(); doFlash("warn");
      showBanner("err", e.message || "Scan failed");
    }
  }, [agg, currentBin, pickedByItemId, recordScan, doFlash, showBanner]);

  useScanRefocus(binScanRef, !currentBin && !completing && !result);
  useScanRefocus(itemScanRef, !!currentBin && !completing && !result);

  // ─── Manual +1 (no-UPC items, scanner issues, etc.) ──────────
  // Items like laces don't carry a UPC. Picker taps +1 on the row,
  // confirms, and we record the scan against the item's primary bin
  // (first bin from binAvailability, which the detail endpoint sorts
  // ascending). If there's no bin data we can't record the scan, so
  // the button is disabled.
  const handleManualAdd = useCallback(async (row) => {
    const label = row.meta.sku || `#${row.itemId}`;
    const primary = row.bins?.[0];
    const binId = primary?.binId || currentBin?.binId || null;
    const binNumber = primary?.binNumber || currentBin?.binNumber || null;
    if (!binId) {
      beepWarn();
      showBanner("warn", `No bin data for ${label} — scan a bin first`);
      return;
    }
    if (!confirm(
      `Mark one ${label} as picked from ${binNumber}?\n\nOnly use this if the item can't be scanned (missing UPC, etc.).`
    )) return;
    try {
      await recordScan({ itemId: row.itemId, binId, qty: 1 });
      beepOk();
      showBanner("ok", `+1 ${label} (manual)`, 1200);
    } catch (e) {
      beepWarn();
      showBanner("err", e.message || "Manual add failed");
    }
  }, [currentBin, recordScan, showBanner]);

  // ─── Mark item unavailable ────────────────────────────────────
  // Picker tap: "can't find any more of this." Removes it from the
  // "still need to pick" list and lets the wave ship despite the
  // shortage. Admin gets a log entry (see api/so-sessions/[id]/fulfill.js).
  const handleToggleUnavailable = useCallback(async (row) => {
    const iid = row.itemId;
    const isNow = row.unavailable;
    try {
      if (isNow) {
        await undoUnavailable(iid);
        showBanner("ok", `${row.meta.sku || "Item"} back on the list`, 1500);
      } else {
        const label = row.meta.sku || `#${iid}`;
        const picked = row.picked || 0;
        const missing = row.need - picked;
        if (!confirm(
          `Mark ${label} as unavailable?\n\nShipping ${picked} of ${row.need}. Admin will follow up with the customer about the ${missing} missing unit${missing === 1 ? "" : "s"}.`
        )) return;
        await markUnavailable(iid);
        beepOk();
        showBanner("ok", `${label} marked unavailable`, 1800);
      }
    } catch (e) {
      beepWarn();
      showBanner("err", e.message || "Update failed");
    }
  }, [markUnavailable, undoUnavailable, showBanner]);

  // ─── Remove SO from wave ──────────────────────────────────────
  const handleRemoveSO = useCallback(async (soId) => {
    const d = detailBySO[soId];
    const label = d?.tranId || `#${soId}`;
    if (session?.soIds?.length <= 1) {
      showBanner("warn", "Can't remove the last SO — tap Back to exit the wave");
      return;
    }
    if (!confirm(`Remove ${label} from the wave? Scans stay; any already-picked units just go toward the remaining SOs.`)) return;
    setRemovingSOId(soId);
    try {
      await removeSO(soId);
      // Drop cached detail so it doesn't linger in the aggregate.
      setDetailBySO((prev) => {
        const next = { ...prev };
        delete next[soId];
        return next;
      });
      beepOk();
      showBanner("ok", `${label} removed`, 1800);
    } catch (e) {
      beepWarn();
      showBanner("err", e.message || "Remove failed");
    } finally {
      setRemovingSOId(null);
    }
  }, [detailBySO, session?.soIds, removeSO, showBanner]);

  // ─── Complete wave ────────────────────────────────────────────
  const onTapComplete = useCallback(async () => {
    if (totalPicked === 0 && unavailableItemIds.size === 0) {
      showBanner("warn", "No scans yet — can't complete");
      return;
    }
    const msg =
      pendingRows > 0
        ? `Complete with ${totalPicked}/${totalNeed} picked and ${pendingRows} item${pendingRows === 1 ? "" : "s"} still unresolved? Those SOs will stay Partially Fulfilled.`
        : unavailableItemIds.size > 0
          ? `Complete & ship ${totalPicked}/${totalNeed}? ${unavailableItemIds.size} item${unavailableItemIds.size === 1 ? "" : "s"} marked unavailable will be logged for admin follow-up.`
          : `Complete wave (${totalPicked}/${totalNeed})?`;
    if (!confirm(msg)) return;
    setCompleting(true);
    try {
      const r = await complete();
      setResult(r);
      beepOk();
    } catch (e) {
      showBanner("err", e.message || "Complete failed");
    } finally {
      setCompleting(false);
    }
  }, [totalPicked, totalNeed, pendingRows, unavailableItemIds, complete, showBanner]);

  // ─── Early states ─────────────────────────────────────────────
  if (!session) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={{ padding: 16 }}><div style={S.err}>No wave session</div></div>
      </div>
    );
  }

  if (detailLoading && Object.keys(detailBySO).length === 0) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
        </div>
        <div style={{ padding: 16 }}>
          <PulsingDot color={ACCENT} label={`Loading ${session.soIds.length} SO${session.soIds.length === 1 ? "" : "s"}...`} />
        </div>
      </div>
    );
  }

  if (detailError && Object.keys(detailBySO).length === 0) {
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={S.err}>{detailError}</div>
        </div>
      </div>
    );
  }

  // ─── Completion result view ───────────────────────────────────
  if (result) {
    const any = result.results || [];
    const shipped = any.filter((r) => r.status === "shipped");
    const partial = any.filter((r) => r.status === "picked_partial");
    const skipped = any.filter((r) => r.status === "skipped_no_allocation");
    const failed  = any.filter((r) => r.status === "error");
    return (
      <div style={S.root}>
        <style>{FONT}{ANIMATIONS}</style>
        <div style={S.hdr}>
          <Logo />
          <button onClick={onComplete} style={{ ...S.btnSm, fontSize: 12 }}>Done →</button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ ...S.card, padding: 16, marginBottom: 12, background: `${ACCENT}12`, border: `1px solid ${ACCENT}35` }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: ACCENT, marginBottom: 4 }}>
              Wave Complete
            </div>
            <div style={{ fontSize: 12, color: "#cbd5e1" }}>
              {shipped.length} shipped · {partial.length} partial · {skipped.length} skipped{failed.length ? ` · ${failed.length} error` : ""}
            </div>
          </div>

          <ResultGroup title="Shipped" color={ACCENT} rows={shipped} />
          <ResultGroup title="Partial (left as Picked)" color={WARN} rows={partial} />
          <ResultGroup title="Skipped (no items picked)" color="#64748b" rows={skipped} />
          <ResultGroup title="Errors" color={ERR} rows={failed} />
        </div>
      </div>
    );
  }

  // ─── Main pick UI ─────────────────────────────────────────────
  const bannerColor = banner
    ? (banner.kind === "ok" ? ACCENT : banner.kind === "err" ? ERR : WARN)
    : null;

  return (
    <div style={S.root}>
      <style>{FONT}{ANIMATIONS}</style>

      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <button
            onClick={() => setManageOpen(true)}
            style={{
              ...S.btnSm,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 0.3,
              padding: "6px 10px",
              background: "transparent",
              border: "1px solid #334155",
            }}
          >
            Wave · {session.soIds.length} SO{session.soIds.length === 1 ? "" : "s"} ▾
          </button>
        </div>
        <button onClick={onBack} style={{ ...S.btnSm, fontSize: 12 }}>← Back</button>
      </div>

      {/* flash overlay */}
      {flash && (
        <div style={{
          position: "fixed", inset: 0, pointerEvents: "none",
          background: flash === "ok" ? `${ACCENT}20` : flash === "bin" ? "rgba(99,102,241,0.18)" : "rgba(239,68,68,0.22)",
          transition: "background 200ms",
          zIndex: 1,
        }} />
      )}

      {/* Manage wave modal */}
      {manageOpen && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 10,
            background: "rgba(2,6,23,0.75)",
            display: "flex", alignItems: "flex-end", justifyContent: "center",
          }}
          onClick={() => setManageOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 480,
              background: "#0b1220",
              borderTop: "1px solid #1e293b",
              borderRadius: "12px 12px 0 0",
              padding: 16,
              maxHeight: "80vh",
              overflow: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>Wave ({session.soIds.length})</div>
              <button onClick={() => setManageOpen(false)} style={{ ...S.btnSm, fontSize: 12 }}>Close</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {session.soIds.map((sid) => {
                const d = detailBySO[sid];
                const removing = removingSOId === sid;
                const onlyOne = session.soIds.length <= 1;
                return (
                  <div
                    key={sid}
                    style={{
                      ...S.card,
                      padding: "10px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      border: `1px solid ${ACCENT}25`,
                      background: `${ACCENT}06`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                        {d?.tranId || `#${sid}`}
                      </div>
                      {d?.customerName && (
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {d.customerName}
                        </div>
                      )}
                      {d?.lines && (
                        <div style={{ fontSize: 10, color: "#64748b", marginTop: 2, ...mono }}>
                          {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveSO(sid)}
                      disabled={removing || onlyOne}
                      title={onlyOne ? "Can't remove the last SO — tap Back to exit" : "Remove from wave"}
                      style={{
                        padding: "6px 10px",
                        fontSize: 11,
                        fontWeight: 700,
                        color: onlyOne ? "#475569" : ERR,
                        background: onlyOne ? "transparent" : `${ERR}10`,
                        border: `1px solid ${onlyOne ? "#334155" : `${ERR}40`}`,
                        borderRadius: 4,
                        cursor: removing || onlyOne ? "default" : "pointer",
                        opacity: removing ? 0.5 : 1,
                        touchAction: "manipulation",
                      }}
                    >
                      {removing ? "..." : "Remove"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 12, lineHeight: 1.4 }}>
              Removing an SO keeps your existing scans. Any scanned units the removed SO would have used just feed the remaining SOs FIFO.
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: "10px 14px 180px", position: "relative", zIndex: 2 }}>
        {/* Progress */}
        <div style={{ ...S.card, padding: 10, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
            <span style={{ color: "#94a3b8" }}>📍 {location?.name}</span>
            <span style={{ color: "#e2e8f0", fontWeight: 700, ...mono }}>
              {totalPicked} / {totalNeed}
            </span>
          </div>
        </div>

        {/* Bin scan or current bin */}
        {!currentBin ? (
          <div style={{ ...S.card, padding: 12, marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", marginBottom: 4, letterSpacing: 0.3 }}>
              SCAN A BIN
            </label>
            <ScanInput onScan={handleBinScan} placeholder="Scan bin..." inputRef={binScanRef} />
          </div>
        ) : (
          <div style={{ ...S.card, padding: 10, marginBottom: 8, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.35)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: 0.3 }}>CURRENT BIN</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                  {currentBin.binNumber}
                </div>
              </div>
              <button
                onClick={() => setCurrentBin(null)}
                style={{ ...S.btnSm, fontSize: 11 }}
              >
                Change bin
              </button>
            </div>
          </div>
        )}

        {/* Item scan */}
        {currentBin && (
          <div style={{ ...S.card, padding: 12, marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 11, color: "#94a3b8", marginBottom: 4, letterSpacing: 0.3 }}>
              SCAN ITEM
            </label>
            <ScanInput onScan={handleItemScan} placeholder="Scan item..." inputRef={itemScanRef} />
          </div>
        )}

        {banner && (
          <div
            style={{
              padding: "6px 10px",
              marginBottom: 8,
              borderRadius: 4,
              background: `${bannerColor}18`,
              border: `1px solid ${bannerColor}55`,
              color: bannerColor,
              fontSize: 12,
              fontWeight: 600,
              ...mono,
            }}
          >
            {banner.text}
          </div>
        )}

        {/* Pick list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, ...fadeIn }}>
          {sortedItems.map((row) => {
            const done = row.picked >= row.need;
            const unavail = row.unavailable;
            const borderColor = unavail ? `${WARN}40` : done ? "#334155" : `${ACCENT}30`;
            const bg = unavail
              ? `${WARN}10`
              : done
                ? "rgba(30,41,59,0.6)"
                : `${ACCENT}06`;
            return (
              <div
                key={row.itemId}
                style={{
                  ...S.card,
                  padding: "10px 12px",
                  border: `1px solid ${borderColor}`,
                  background: bg,
                  opacity: done && !unavail ? 0.5 : 1,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: unavail ? "#94a3b8" : "#e2e8f0",
                      textDecoration: unavail ? "line-through" : "none",
                      ...mono,
                    }}
                  >
                    {row.meta.sku || `#${row.itemId}`}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: unavail ? WARN : done ? "#64748b" : ACCENT,
                      ...mono,
                    }}
                  >
                    {unavail ? `short ${row.need - row.picked}` : `${row.picked}/${row.need}`}
                  </div>
                </div>
                {row.meta.description && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "#94a3b8",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textDecoration: unavail ? "line-through" : "none",
                    }}
                  >
                    {row.meta.description}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <div style={{ fontSize: 10, color: "#64748b", ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.bins.length
                      ? row.bins.map((b) => `${b.binNumber}(${b.qtyOnHand})`).join("  ")
                      : "no stock at this location"}
                  </div>
                  {!done && !unavail && (
                    <button
                      onClick={() => handleManualAdd(row)}
                      title="Manual +1 (for items without UPC)"
                      style={{
                        padding: "4px 10px",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                        color: ACCENT,
                        background: `${ACCENT}10`,
                        border: `1px solid ${ACCENT}40`,
                        borderRadius: 4,
                        cursor: "pointer",
                        touchAction: "manipulation",
                        flexShrink: 0,
                      }}
                    >
                      +1 Manual
                    </button>
                  )}
                  {!done && (
                    <button
                      onClick={() => handleToggleUnavailable(row)}
                      style={{
                        padding: "4px 10px",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                        color: unavail ? ACCENT : WARN,
                        background: unavail ? `${ACCENT}10` : `${WARN}10`,
                        border: `1px solid ${unavail ? `${ACCENT}40` : `${WARN}40`}`,
                        borderRadius: 4,
                        cursor: "pointer",
                        textTransform: "uppercase",
                        touchAction: "manipulation",
                        flexShrink: 0,
                      }}
                    >
                      {unavail ? "↺ Undo" : "Unavailable"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {sortedItems.length === 0 && (
            <div style={{ ...S.card, padding: 20, textAlign: "center", color: "#94a3b8" }}>
              No inventory lines at {location?.name} for the selected SOs.
            </div>
          )}
        </div>
      </div>

      {/* Complete bar */}
      <div
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0,
          padding: 12,
          background: "#0b1220",
          borderTop: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          gap: 10,
          zIndex: 3,
        }}
      >
        <div style={{ fontSize: 11, color: "#64748b", flex: 1, ...mono }}>
          {totalPicked}/{totalNeed} across {session.soIds.length} SO{session.soIds.length === 1 ? "" : "s"}
        </div>
        <button
          onClick={onTapComplete}
          disabled={completing || (totalPicked === 0 && unavailableItemIds.size === 0)}
          style={{
            padding: "10px 18px",
            background:
              totalPicked === 0 && unavailableItemIds.size === 0
                ? "#334155"
                : pendingRows > 0
                  ? WARN
                  : ACCENT,
            color: "#0f172a",
            fontSize: 14,
            fontWeight: 700,
            border: "none",
            borderRadius: 6,
            cursor: completing ? "default" : "pointer",
            opacity: completing ? 0.6 : 1,
            touchAction: "manipulation",
          }}
        >
          {completing
            ? "Completing..."
            : pendingRows > 0
              ? `Complete Partial`
              : `Complete & Ship`}
        </button>
      </div>
    </div>
  );
}

function ResultGroup({ title, color, rows }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4, letterSpacing: 0.3, textTransform: "uppercase" }}>
        {title} ({rows.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r) => (
          <div
            key={r.soId}
            style={{
              ...S.card,
              padding: "8px 10px",
              border: `1px solid ${color}30`,
              background: `${color}06`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", ...mono }}>
                {r.tranId || `#${r.soId}`}
              </span>
              {r.fulfillmentId && (
                <span style={{ fontSize: 11, color: "#64748b", ...mono }}>
                  IF{r.fulfillmentId}
                </span>
              )}
            </div>
            {r.error && (
              <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>{r.error}</div>
            )}
            {r.shortages && r.shortages.length > 0 && (
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2, ...mono }}>
                short {r.shortages.reduce((s, x) => s + (Number(x.short) || 0), 0)} unit(s)
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
