import {
  getWaveSession,
  writeWaveSession,
  newWaveSessionId,
  getSOLock,
} from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// POST /api/so-sessions
//
// Create a new wave-pick session OR resume an existing one owned by
// the same picker. Body:
//   { pickerName: "Bryce", locationId: "3", soIds: ["12345"] }
//
// Rules:
//   - Any soId already locked by another session → 409 with lock info
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
        conflicts.push({
          soId: soIds[i],
          lockedBy: owning.pickerName,
          lockedAt: owning.updatedAt,
          lockedSessionId: lockOwner,
        });
      }
    }
    if (conflicts.length > 0) {
      return res.status(409).json({ error: "locked", conflicts });
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
