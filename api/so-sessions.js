import { kv } from "@vercel/kv";
import {
  getWaveSession,
  writeWaveSession,
  newWaveSessionId,
  getSOLock,
  KEY_SO_LOCK,
  KEY_WAVE_SESSION,
} from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// POST /api/so-sessions
//
// Create a new wave-pick session OR resume an existing one owned by
// the same picker. Body:
//   { pickerName: "Bryce", locationId: "3", soIds: ["12345"],
//     force?: true }
//
// Rules:
//   - Any soId already locked by another session → 409 with lock info
//   - `force: true` overrides the lock ONLY if the other picker's
//     wave has zero scan events (i.e. they reserved the SO but never
//     actually picked anything). Waves with scans are still protected.
//   - If the caller passes a sessionId and same soIds match, return
//     the existing session (resume UX).
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
    // ─── Check each SO for existing locks ───
    const locks = await Promise.all(soIds.map((id) => getSOLock(id)));
    const conflicts = [];
    for (let i = 0; i < soIds.length; i++) {
      const lockOwner = locks[i];
      if (!lockOwner) continue;
      const owning = await getWaveSession(lockOwner);
      if (owning && owning.pickerName !== pickerName) {
        const hasScans = (owning.events || []).some((e) => e?.type === "scan");
        conflicts.push({
          soId: soIds[i],
          lockedBy: owning.pickerName,
          lockedAt: owning.updatedAt,
          lockedSessionId: lockOwner,
          hasScans,
        });
      }
    }

    if (conflicts.length > 0) {
      if (!force) {
        return res.status(409).json({ error: "locked", conflicts });
      }
      // force=true — only release locks on waves with zero scans. Any
      // wave with real work in progress is still protected.
      const unreleasable = conflicts.filter((c) => c.hasScans);
      if (unreleasable.length > 0) {
        return res.status(409).json({
          error: "locked_with_scans",
          conflicts: unreleasable,
          note: "One or more conflicting waves already have scans and cannot be overridden. The picker who owns them must pause or complete first.",
        });
      }
      // Safe to release. For each conflict, drop the specific SO from
      // the other wave (keeps their remaining wave intact) and unset
      // the SO lock.
      for (const c of conflicts) {
        const otherSessionId = c.lockedSessionId;
        const other = await kv.get(KEY_WAVE_SESSION(otherSessionId));
        if (other) {
          const nextSoIds = (other.soIds || []).filter((id) => id !== c.soId);
          if (nextSoIds.length === 0) {
            // That was their only SO — delete the wave entirely so we
            // don't leave an orphan session behind.
            await kv.del(KEY_WAVE_SESSION(otherSessionId));
          } else {
            await kv.set(
              KEY_WAVE_SESSION(otherSessionId),
              { ...other, soIds: nextSoIds, updatedAt: new Date().toISOString() },
            );
          }
        }
        await kv.del(KEY_SO_LOCK(c.soId));
      }
    }

    // ─── Resume (same picker already owns these SOs) ───
    // If any of these SOs is already locked by this picker's wave, merge into that wave.
    const existingOwned = [];
    for (let i = 0; i < soIds.length; i++) {
      const lockOwner = locks[i];
      if (!lockOwner) continue;
      const owning = await getWaveSession(lockOwner);
      if (owning && owning.pickerName === pickerName) {
        existingOwned.push(owning);
      }
    }
    // If we found a single owning wave, extend it with the new soIds.
    const uniqueOwningIds = [...new Set(existingOwned.map((s) => s.sessionId))];
    if (uniqueOwningIds.length === 1) {
      const existing = existingOwned[0];
      const merged = {
        ...existing,
        soIds: [...new Set([...(existing.soIds || []), ...soIds])],
        updatedAt: new Date().toISOString(),
      };
      await writeWaveSession(merged);
      return res.status(200).json(merged);
    }
    if (uniqueOwningIds.length > 1) {
      // Picker owns multiple waves that overlap with this request — ambiguous.
      return res.status(409).json({
        error: "multiple_existing_waves",
        conflicts: existingOwned.map((s) => ({
          sessionId: s.sessionId,
          soIds: s.soIds,
        })),
      });
    }

    // ─── Create new session ───
    const now = new Date().toISOString();
    const session = {
      sessionId: newWaveSessionId(),
      pickerName,
      locationId,
      soIds,
      createdAt: now,
      updatedAt: now,
      status: "active",
      events: [],
    };
    await writeWaveSession(session);
    return res.status(201).json(session);
  } catch (err) {
    console.error("so-sessions POST error:", err);
    return res.status(500).json({ error: err.message });
  }
}
