import { kv } from "@vercel/kv";
import {
  getWaveSession,
  writeWaveSession,
  deleteWaveSession,
  newEventId,
  getSOLock,
  KEY_SO_LOCK,
} from "../_kv.js";

// ═══════════════════════════════════════════════════════════
// GET   /api/so-sessions/:id  → current session state
// PATCH /api/so-sessions/:id  → append event, may mutate soIds/status
//
// Supported event types:
//   scan       { itemId, binId, qty }         — picker scanned an item
//   add_so     { soId }                        — extend wave mid-pick
//   remove_so  { soId }                        — drop an SO from wave
//   pause      { }                             — picker paused
//   take_over  { newPickerName }               — new picker claims wave
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionId = req.query?.id;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId path param" });
  }

  try {
    const session = await getWaveSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (req.method === "GET") return res.status(200).json(session);
    if (req.method === "PATCH") return await handlePatch(req, res, session);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(`so-sessions [${req.method}] error:`, err);
    return res.status(500).json({ error: err.message });
  }
}

async function handlePatch(req, res, session) {
  const body = req.body || {};
  const { type, clientEventId, deviceId } = body;

  if (!type || typeof type !== "string") {
    return res.status(400).json({ error: "Missing 'type' on event body" });
  }
  if (!clientEventId || typeof clientEventId !== "string") {
    return res.status(400).json({ error: "Missing 'clientEventId' — required for idempotency" });
  }
  if (session.events.some((e) => e.clientEventId === clientEventId)) {
    return res.status(200).json(session);
  }

  if (type !== "take_over") {
    const claimed = typeof body.pickerName === "string" ? body.pickerName.trim() : "";
    if (!claimed) return res.status(400).json({ error: "Missing 'pickerName' on event body" });
    if (claimed !== session.pickerName) {
      return res.status(409).json({
        error: "session_taken_over",
        lockedBy: session.pickerName,
        lockedAt: session.updatedAt,
      });
    }
  }

  const now = new Date().toISOString();
  const baseEvent = {
    eventId: newEventId(),
    clientEventId,
    timestamp: now,
    deviceId: deviceId || null,
    type,
  };

  let newEvent;
  let statusUpdate = null;
  let pickerUpdate = null;
  let soIdsUpdate = null;

  switch (type) {
    case "scan": {
      const { itemId, binId, qty } = body;
      if (!itemId || !binId || qty == null) {
        return res.status(400).json({ error: "Scan event requires itemId, binId, qty" });
      }
      const qtyNum = Number(qty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        return res.status(400).json({ error: "qty must be a positive number" });
      }
      newEvent = { ...baseEvent, itemId: String(itemId), binId: String(binId), qty: qtyNum };
      break;
    }
    case "add_so": {
      const soId = body.soId != null ? String(body.soId) : "";
      if (!soId) return res.status(400).json({ error: "add_so requires soId" });
      if ((session.soIds || []).includes(soId)) {
        return res.status(200).json(session); // already in wave, idempotent
      }
      // Check the target SO isn't locked by another session.
      const lockOwner = await getSOLock(soId);
      if (lockOwner && lockOwner !== session.sessionId) {
        return res.status(409).json({ error: "so_locked_by_other_session", lockedSessionId: lockOwner });
      }
      soIdsUpdate = [...(session.soIds || []), soId];
      newEvent = { ...baseEvent, soId };
      break;
    }
    case "remove_so": {
      const soId = body.soId != null ? String(body.soId) : "";
      if (!soId) return res.status(400).json({ error: "remove_so requires soId" });
      if (!(session.soIds || []).includes(soId)) {
        return res.status(200).json(session); // not in wave, idempotent
      }
      soIdsUpdate = (session.soIds || []).filter((id) => id !== soId);
      if (soIdsUpdate.length === 0) {
        return res.status(400).json({ error: "cannot_remove_last_so" });
      }
      newEvent = { ...baseEvent, soId };
      break;
    }
    case "pause": {
      newEvent = { ...baseEvent };
      statusUpdate = "paused";
      break;
    }
    case "take_over": {
      const newPickerName = typeof body.newPickerName === "string" ? body.newPickerName.trim() : "";
      if (!newPickerName) {
        return res.status(400).json({ error: "take_over requires newPickerName" });
      }
      newEvent = { ...baseEvent, previousPicker: session.pickerName, newPicker: newPickerName };
      pickerUpdate = newPickerName;
      statusUpdate = "active";
      break;
    }
    default:
      return res.status(400).json({ error: `Unknown event type: ${type}` });
  }

  const updated = {
    ...session,
    events: [...session.events, newEvent],
    updatedAt: now,
    ...(statusUpdate ? { status: statusUpdate } : {}),
    ...(pickerUpdate ? { pickerName: pickerUpdate } : {}),
    ...(soIdsUpdate ? { soIds: soIdsUpdate } : {}),
  };

  // If we removed an SO, drop its lock key so another wave can claim it.
  if (type === "remove_so") {
    const removedSoId = body.soId != null ? String(body.soId) : "";
    if (removedSoId) await kv.del(KEY_SO_LOCK(removedSoId));
  }

  await writeWaveSession(updated);
  return res.status(200).json(updated);
}

// Re-exporting for DELETE if we ever add it
export { deleteWaveSession };
