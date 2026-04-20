import {
  getSessionByToId,
  writeSession,
  newSessionId,
} from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// POST /api/pick-sessions
// Create a new pick session or return the existing one if the
// same picker already owns it. Returns 409 if locked by another.
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.3
// ═══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // ─── CORS ───
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ─── Parse & validate ───
  const body = req.body || {};
  const toId = body.toId != null ? String(body.toId) : "";
  const pickerName = typeof body.pickerName === "string" ? body.pickerName.trim() : "";

  if (!toId) return res.status(400).json({ error: "Missing 'toId' in request body" });
  if (!pickerName) return res.status(400).json({ error: "Missing 'pickerName' in request body" });

  try {
    // ─── Resume if existing session owned by same picker ───
    const existing = await getSessionByToId(toId);
    if (existing) {
      if (existing.pickerName === pickerName) {
        return res.status(200).json(existing);
      }
      // Locked by another picker — client shows TakeoverModal
      return res.status(409).json({
        error: "locked",
        lockedBy: existing.pickerName,
        lockedAt: existing.updatedAt,
        sessionId: existing.sessionId,
      });
    }

    // ─── Create new session ───
    const now = new Date().toISOString();
    const session = {
      sessionId: newSessionId(),
      toId,
      pickerName,
      createdAt: now,
      updatedAt: now,
      status: "active",
      events: [],
    };

    await writeSession(session);
    return res.status(201).json(session);
  } catch (err) {
    console.error("pick-sessions POST error:", err);
    return res.status(500).json({ error: err.message });
  }
}
