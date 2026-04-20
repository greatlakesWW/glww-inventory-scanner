import {
  getSessionBySessionId,
  writeSession,
  newEventId,
} from "../_kv.js";

// ═══════════════════════════════════════════════════════════
// GET  /api/pick-sessions/:id  — read current session state
// PATCH /api/pick-sessions/:id — append an event; may mutate status / pickerName
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.4, §4.5
// ═══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // ─── CORS ───
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const sessionId = req.query?.id;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId path param" });
  }

  try {
    const session = await getSessionBySessionId(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (req.method === "GET") {
      return res.status(200).json(session);
    }

    if (req.method === "PATCH") {
      return handlePatch(req, res, session);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(`pick-sessions [${req.method}] error:`, err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
// PATCH — append an event
// ═══════════════════════════════════════════════════════════
async function handlePatch(req, res, session) {
  const body = req.body || {};
  const { type, clientEventId, deviceId } = body;

  // ─── Shape validation ───
  if (!type || typeof type !== "string") {
    return res.status(400).json({ error: "Missing 'type' on event body" });
  }
  if (!clientEventId || typeof clientEventId !== "string") {
    return res.status(400).json({ error: "Missing 'clientEventId' — required for idempotency" });
  }

  // ─── Idempotency: replay same clientEventId → return current session unchanged ───
  if (session.events.some((e) => e.clientEventId === clientEventId)) {
    return res.status(200).json(session);
  }

  // ─── Ownership check (except for take_over which transfers it) ───
  if (type !== "take_over") {
    const claimedPicker = typeof body.pickerName === "string" ? body.pickerName.trim() : "";
    if (!claimedPicker) {
      return res.status(400).json({ error: "Missing 'pickerName' on event body" });
    }
    if (claimedPicker !== session.pickerName) {
      return res.status(409).json({
        error: "session_taken_over",
        lockedBy: session.pickerName,
        lockedAt: session.updatedAt,
      });
    }
  }

  // ─── Type-specific handling ───
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

  switch (type) {
    case "scan": {
      const { lineId, itemId, binId, qty } = body;
      if (!lineId || !itemId || !binId || qty == null) {
        return res.status(400).json({
          error: "Scan event requires lineId, itemId, binId, qty",
        });
      }
      const qtyNum = Number(qty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        return res.status(400).json({ error: "qty must be a positive number" });
      }
      // TODO(session 2/5): add TO-data-dependent validations:
      //   - item_not_on_to    (itemId not found on any line of this TO)
      //   - line_complete     (cumulative picked already == qtyOrdered)
      //   - bin_not_in_source_location (bin doesn't belong to TO source location)
      // These reject reasons are specified in §4.4 but need TO lines + binonhand,
      // which session 2 adds via GET /api/transfer-orders/:id.
      newEvent = { ...baseEvent, lineId: String(lineId), itemId: String(itemId), binId: String(binId), qty: qtyNum };
      break;
    }

    case "switch_bin": {
      const { binId } = body;
      if (!binId) return res.status(400).json({ error: "switch_bin event requires binId" });
      newEvent = { ...baseEvent, binId: String(binId) };
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
        return res.status(400).json({ error: "take_over event requires 'newPickerName'" });
      }
      newEvent = {
        ...baseEvent,
        previousPicker: session.pickerName,
        newPicker: newPickerName,
      };
      pickerUpdate = newPickerName;
      statusUpdate = "active"; // takeover resumes an active session
      break;
    }

    default:
      return res.status(400).json({ error: `Unknown event type: ${type}` });
  }

  // ─── Apply updates, write back ───
  const updated = {
    ...session,
    events: [...session.events, newEvent],
    updatedAt: now,
    ...(statusUpdate ? { status: statusUpdate } : {}),
    ...(pickerUpdate ? { pickerName: pickerUpdate } : {}),
  };

  await writeSession(updated);
  return res.status(200).json(updated);
}
