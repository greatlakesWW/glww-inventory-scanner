import { kv } from "@vercel/kv";
import { getSuiteQLConfig } from "./_suiteql.js";
import { generateOAuthHeader } from "./_auth.js";
import { KEY_SESSION_BY_TO } from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// GET /api/transfer-orders?location={id}
//
// All REST Record API — no SuiteQL. Established via diagnostic
// sessions 2a/2b:
//   - SuiteQL's t.location and t.transferlocation did not match
//     TO 523165 (known to have REST location.id = 5) under any
//     combination tested.
//   - REST search field vocab for transferOrder is opaque; direct
//     filters like `location ANY_OF [5]` returned empty.
//   - Both the REST list (ids only) AND per-id REST header fetches
//     work reliably.
//
// Flow:
//   1. REST list /transferOrder (paginated) — gets every TO id.
//   2. Fetch each TO's header fields in parallel via REST.
//   3. JS filter: to.location.id matches requested source location
//      AND status is open.
//   4. KV merge for lockedBy/lockedAt.
//
// At ~132 TOs in this account the parallel header fetches complete
// in a couple of seconds. If the count grows, we can add a client-
// side location hint or switch to SuiteAnalytics Connect.
//
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.1
// ═══════════════════════════════════════════════════════════

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
  return candidates.some((c) => OPEN_STATUS_TOKENS.has(String(c).toLowerCase()));
}

// Fetch every transferOrder id, paginating until exhausted. Caps at 2000 for safety.
async function listAllTransferOrderIds(config) {
  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder`;
  const PAGE = 1000;
  let offset = 0;
  const ids = [];
  while (true) {
    const qp = { limit: String(PAGE), offset: String(offset) };
    const fullUrl = `${baseUrl}?limit=${PAGE}&offset=${offset}`;
    const authHeader = generateOAuthHeader("GET", baseUrl, qp, config);
    const resp = await fetch(fullUrl, { method: "GET", headers: { Authorization: authHeader } });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`transferOrder list ${resp.status}: ${text.slice(0, 300)}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    const data = await resp.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const it of items) if (it.id) ids.push(it.id);
    if (!data?.hasMore || items.length === 0) break;
    offset += items.length;
    if (ids.length >= 2000) break; // safety
  }
  return ids;
}

async function fetchHeader(config, id) {
  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder/${id}`;
  const fieldList = "id,tranId,tranDate,status,location,transferLocation";
  const qp = { fields: fieldList };
  const fullUrl = `${baseUrl}?fields=${encodeURIComponent(fieldList)}`;
  const authHeader = generateOAuthHeader("GET", baseUrl, qp, config);
  try {
    const r = await fetch(fullUrl, { method: "GET", headers: { Authorization: authHeader } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Run N async tasks with a concurrency cap to avoid opening 132+ sockets at once.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
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

    // 1. All TO ids
    const ids = await listAllTransferOrderIds(config);

    // 2. Headers in parallel with concurrency cap
    const headers = (await mapWithConcurrency(ids, 20, (id) => fetchHeader(config, id)))
      .filter((h) => h && h.id);

    // 3. Filter: open status + source location = requested
    const tos = headers.filter((to) => {
      if (!isOpenStatus(to.status)) return false;
      const src = to.location?.id != null ? Number(to.location.id) : null;
      return src === locationId;
    });

    // 4. KV lock merge
    const sessions = await Promise.all(
      tos.map((to) => kv.get(KEY_SESSION_BY_TO(String(to.id))))
    );

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
