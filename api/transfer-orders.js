import { kv } from "@vercel/kv";
import { runSuiteQL, getSuiteQLConfig } from "./_suiteql.js";
import { generateOAuthHeader } from "./_auth.js";
import { KEY_SESSION_BY_TO } from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// GET /api/transfer-orders?location={id}
//
// HYBRID flow:
//   1. SuiteQL gets the list of TO internal IDs at the source location
//      (no NOT_EXPOSED fields — just transaction header, which is safe).
//   2. REST Record API fetches each TO's header fields (tranId, status,
//      locations, date) because the REST endpoint has broader field
//      exposure than SuiteQL's SEARCH channel.
//   3. Status filter runs in JS over the fetched headers.
//   4. KV merge adds lock state.
//
// Why hybrid: SuiteQL has working location filtering on transaction; the
// REST SEARCH language for transferOrder has an opaque `location` /
// `transferLocation` vocabulary that didn't behave like the record shape.
// Rather than keep guessing at the right REST search field, use SuiteQL
// where it works and REST where we need the full field exposure.
//
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.1
// ═══════════════════════════════════════════════════════════

// Statuses we consider "open outbound" — pickable. REST returns status as
// either enum string, refName display, or {id, refName}. Normalize all.
const OPEN_STATUS_TOKENS = new Set([
  "pendingfulfillment",
  "partiallyfulfilled",
  "pending fulfillment",
  "partially fulfilled",
]);

function isOpenStatus(raw) {
  const candidates = [];
  if (typeof raw === "string") candidates.push(raw);
  if (raw && typeof raw === "object") {
    if (raw.id) candidates.push(String(raw.id));
    if (raw.refName) candidates.push(String(raw.refName));
  }
  return candidates.some((c) => OPEN_STATUS_TOKENS.has(c.toLowerCase()));
}

export default async function handler(req, res) {
  // ─── CORS ───
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const location = req.query?.location;
  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "Missing 'location' query parameter" });
  }
  const locationId = Number(location);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: "'location' must be a positive integer" });
  }

  try {
    const config = getSuiteQLConfig();

    // ─── Step 1: SuiteQL list of TO IDs at this location ───
    // Safe query — only touches transaction header fields, no NOT_EXPOSED
    // transactionline fields.
    const idQuery = `
      SELECT t.id AS internalid
      FROM transaction t
      WHERE t.type = 'TrnfrOrd'
        AND t.location = ${locationId}
    `;
    const { items: idRows } = await runSuiteQL(idQuery);
    const toIds = idRows.map((r) => Number(r.internalid)).filter((n) => Number.isInteger(n) && n > 0);

    if (toIds.length === 0) {
      return res.status(200).json({ orders: [] });
    }

    // ─── Step 2: fetch headers via REST Record API in parallel ───
    const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder`;
    const fieldList = "id,tranId,tranDate,status,location,transferLocation";

    const detailPromises = toIds.map(async (id) => {
      const recUrl = `${baseUrl}/${id}`;
      const recQp = { fields: fieldList };
      const recFullUrl = `${recUrl}?fields=${encodeURIComponent(fieldList)}`;
      const recAuth = generateOAuthHeader("GET", recUrl, recQp, config);
      try {
        const r = await fetch(recFullUrl, { method: "GET", headers: { Authorization: recAuth } });
        if (!r.ok) {
          console.warn(`TO header fetch ${id} returned ${r.status}`);
          return null;
        }
        return await r.json();
      } catch (e) {
        console.warn(`TO header fetch ${id} error:`, e.message);
        return null;
      }
    });

    const allTos = (await Promise.all(detailPromises)).filter((x) => x && x.id);

    // ─── Step 3: filter to open statuses in JS ───
    const tos = allTos.filter((to) => isOpenStatus(to.status));

    // ─── Step 4: lock-state merge via KV ───
    const sessions = await Promise.all(
      tos.map((to) => kv.get(KEY_SESSION_BY_TO(String(to.id))))
    );

    // ─── Shape response per §4.1 ───
    // lineCount / totalQty are null (omitted). Computing them would require
    // per-TO line queries which would double/triple the request count.
    // Session 4+ can add them on demand if the UI surfaces those numbers.
    const orders = tos.map((to, i) => {
      const sess = sessions[i];
      const srcLoc = to.location || {};
      const dstLoc = to.transferLocation || {};
      const rawStatus = to.status;
      const statusName = typeof rawStatus === "string"
        ? rawStatus
        : rawStatus?.refName || rawStatus?.id || null;
      return {
        id: String(to.id),
        tranId: to.tranId || null,
        orderDate: to.tranDate || null,
        sourceLocationId: srcLoc.id != null ? String(srcLoc.id) : null,
        sourceLocationName: srcLoc.refName || null,
        destinationLocationId: dstLoc.id != null ? String(dstLoc.id) : null,
        destinationLocationName: dstLoc.refName || null,
        status: statusName,
        lineCount: null,
        totalQty: null,
        lockedBy: sess?.pickerName || null,
        lockedAt: sess?.updatedAt || null,
      };
    });

    // Sort by date descending (most recent first). Default NS order isn't reliable.
    orders.sort((a, b) => (b.orderDate || "").localeCompare(a.orderDate || ""));

    return res.status(200).json({ orders });
  } catch (err) {
    console.error("transfer-orders GET error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message,
      ...(err.body ? { details: err.body } : {}),
    });
  }
}
