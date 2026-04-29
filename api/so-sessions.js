import { kv } from "@vercel/kv";
import {
  getWaveSession,
  writeWaveSession,
  newWaveSessionId,
  getSOLock,
  deleteSOLock,
  KEY_SO_LOCK,
  KEY_SO_LOCK_LEGACY,
  KEY_WAVE_SESSION,
} from "./_kv.js";
import { loadSORemainingAtLocation } from "./_so-fulfillment.js";

// ═══════════════════════════════════════════════════════════
// POST /api/so-sessions
//
// Create a new wave-pick session OR resume an existing one owned by
// the same picker. Body:
//   { pickerName: "Bryce", locationId: "3", soIds: ["12345"],
//     force?: true }
//
// Locks are LOCATION-SCOPED — keyed by `{soId, locationId}` — so two
// pickers at different warehouses can simultaneously work different
// lines of the same SO. See PRD-Location-Scoped-SO-Fulfillment.md.
//
// Rules:
//   - Any soId already locked by another session AT THIS LOCATION
//     → 409 with lock info. A lock at a sibling location is not
//     a conflict.
//   - `force: true` overrides the lock ONLY at this location AND
//     ONLY if the other picker's wave has zero scan events.
//   - If the caller passes a sessionId and same {soIds, locationId}
//     match a lock owned by the same picker, the SOs are merged
//     into that wave (resume UX).
//   - H-3: Before creating, validates each requested SO still has
//     unfulfilled lines at the requested location. If a sibling
//     location already cleared them, returns
//     `already_fulfilled_at_location` with the affected SO ids.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = req.body || {};
  const pickerName = typeof body.pickerName === "string" ? body.pickerName.trim() : "";
  const locationId = body.locationId != null ? String(body.locationId) : "";
  const soIds = Array.isArray(body.soIds) ? body.soIds.map(String).filter(Boolean) : [];
  const force = !!body.force;

  if (!pickerName) return res.status(400).json({ error: "Missing 'pickerName'" });
  if (!locationId) return res.status(400).json({ error: "Missing 'locationId'" });
  if (soIds.length === 0) return res.status(400).json({ error: "soIds[] must be non-empty" });

  try {
    // ─── H-3: validate each SO still has unfulfilled lines at this location ───
    // A sibling-location wave may have already cleared this location's
    // lines while the picker was on break. Surface a clear error rather
    // than burning physical labor on stale plan state.
    const remainingChecks = await Promise.all(
      soIds.map(async (id) => {
        try {
          const r = await loadSORemainingAtLocation(id, locationId);
          return { soId: id, ok: !!(r && r.lines && r.lines.length > 0), tranId: r?.tranId || null };
        } catch (e) {
          // Don't block wave creation on a transient NetSuite error —
          // let the existing fulfill-time path handle it. Log so we know.
          console.warn(`H-3 remaining-lines check failed for SO ${id}@loc${locationId}:`, e?.message);
          return { soId: id, ok: true, tranId: null };
        }
      }),
    );
    const alreadyFulfilled = remainingChecks.filter((c) => !c.ok);
    if (alreadyFulfilled.length === soIds.length) {
      return res.status(409).json({
        error: "already_fulfilled_at_location",
        locationId,
        soIds: alreadyFulfilled.map((c) => ({ soId: c.soId, tranId: c.tranId })),
      });
    }
    // Drop any individually-fulfilled SOs from the wave but proceed if
    // at least one is still pickable. The client can show a banner for
    // the dropped ones.
    const droppedSoIds = alreadyFulfilled.map((c) => c.soId);
    const pickableSoIds = soIds.filter((id) => !droppedSoIds.includes(id));

    // ─── Check each remaining SO for an existing lock at THIS location ───
    const locks = await Promise.all(pickableSoIds.map((id) => getSOLock(id, locationId)));
    const conflicts = [];
    for (let i = 0; i < pickableSoIds.length; i++) {
      const lockOwner = locks[i];
      if (!lockOwner) continue;
      const owning = await getWaveSession(lockOwner);
      if (owning && owning.pickerName !== pickerName) {
        const hasScans = (owning.events || []).some((e) => e?.type === "scan");
        conflicts.push({
          soId: pickableSoIds[i],
          lockedBy: owning.pickerName,
          lockedAt: owning.updatedAt,
          lockedSessionId: lockOwner,
          lockedLocationId: owning.locationId || null,
          hasScans,
        });
      }
    }

    if (conflicts.length > 0) {
      if (!force) {
        return res.status(409).json({ error: "locked", conflicts });
      }
      // force=true — only release locks on waves with zero scans, AND
      // only at this location. A wave at a sibling location is invisible
      // to us (different lock key) so this branch never affects it.
      const unreleasable = conflicts.filter((c) => c.hasScans);
      if (unreleasable.length > 0) {
        return res.status(409).json({
          error: "locked_with_scans",
          conflicts: unreleasable,
          note: "One or more conflicting waves already have scans and cannot be overridden. The picker who owns them must pause or complete first.",
        });
      }
      // Safe to release. For each conflict, drop the specific SO from
      // the other wave at this location only.
      for (const c of conflicts) {
        const otherSessionId = c.lockedSessionId;
        const other = await kv.get(KEY_WAVE_SESSION(otherSessionId));
        if (other) {
          // The other session is bound to a single locationId. If it's
          // the same as ours (the only force-reachable case for a
          // scoped lock) drop the SO from their wave. If we're forcing
          // through a LEGACY (un-scoped) lock, the other session's
          // locationId may differ — still drop the SO from theirs since
          // we now own this {soId, locationId} pair and they'd collide
          // at the SO level on fulfill anyway.
          const nextSoIds = (other.soIds || []).filter((id) => id !== c.soId);
          if (nextSoIds.length === 0) {
            await kv.del(KEY_WAVE_SESSION(otherSessionId));
          } else {
            await kv.set(
              KEY_WAVE_SESSION(otherSessionId),
              { ...other, soIds: nextSoIds, updatedAt: new Date().toISOString() },
            );
          }
        }
        // Clear both the scoped key (this location) AND the legacy
        // un-scoped key — the latter only matters during the H-4
        // migration window but it's free insurance.
        await kv.del(KEY_SO_LOCK(c.soId, locationId));
        await kv.del(KEY_SO_LOCK_LEGACY(c.soId));
      }
    }

    // ─── Resume (same picker already owns these SOs at this location) ───
    // Match on pickerName AND locationId — a picker can have separate
    // active waves at different locations for the same SO.
    const existingOwned = [];
    for (let i = 0; i < pickableSoIds.length; i++) {
      const lockOwner = locks[i];
      if (!lockOwner) continue;
      const owning = await getWaveSession(lockOwner);
      if (!owning) continue;
      if (owning.pickerName !== pickerName) continue;
      // Locks are scoped per location; an owning session at a different
      // locationId doesn't merge into this request.
      if (String(owning.locationId || "") !== locationId) continue;
      existingOwned.push(owning);
    }
    const uniqueOwningIds = [...new Set(existingOwned.map((s) => s.sessionId))];
    if (uniqueOwningIds.length === 1) {
      const existing = existingOwned[0];
      const merged = {
        ...existing,
        soIds: [...new Set([...(existing.soIds || []), ...pickableSoIds])],
        updatedAt: new Date().toISOString(),
      };
      await writeWaveSession(merged);
      return res.status(200).json(droppedSoIds.length > 0
        ? { ...merged, droppedSoIds }
        : merged);
    }
    if (uniqueOwningIds.length > 1) {
      return res.status(409).json({
        error: "multiple_existing_waves",
        conflicts: existingOwned.map((s) => ({
          sessionId: s.sessionId,
          soIds: s.soIds,
          locationId: s.locationId,
        })),
      });
    }

    // ─── Create new session ───
    const now = new Date().toISOString();
    const session = {
      sessionId: newWaveSessionId(),
      pickerName,
      locationId,
      soIds: pickableSoIds,
      createdAt: now,
      updatedAt: now,
      status: "active",
      events: [],
    };
    await writeWaveSession(session);
    return res.status(201).json(droppedSoIds.length > 0
      ? { ...session, droppedSoIds }
      : session);
  } catch (err) {
    console.error("so-sessions POST error:", err);
    return res.status(500).json({ error: err.message });
  }
}
