import { kv } from "@vercel/kv";
import { getSuiteQLConfig } from "./_suiteql.js";
import { generateOAuthHeader } from "./_auth.js";
import { KEY_SESSION_BY_TO } from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// GET /api/transfer-orders?location={id}
//
// Returns open Transfer Orders at the given source location.
// Uses the REST Record API (NOT SuiteQL) because NetSuite has
// classified key fields like `quantityfulfilled` as NOT_EXPOSED
// for the SuiteQL SEARCH channel. The REST Record API has
// different, more permissive exposure rules.
//
// Merges in live lock state from Vercel KV so the client can
// render "In Progress by [name]" without a second round trip.
//
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.1
// ═══════════════════════════════════════════════════════════

// Accepted status values (REST Record API enum form). These map to
// SuiteQL codes TrnfrOrd:B and TrnfrOrd:D respectively — the ones the
// production TransferOrders module has always considered "open outbound".
const OPEN_STATUSES = ["pendingFulfillment", "partiallyFulfilled"];

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

    // ─── Step 1: list TOs via REST Record API ───
    // The REST Record API search query language is narrower than the full
    // record schema — `status` isn't a filterable field on transferOrder
    // (returns NONEXISTENT_FIELD). So we only filter by location here and
    // do the status filter in JS after fetching each record's details.
    // Reference fields use ANY_OF, not IS (IS is for string fields). Even for
    // a single value, REST search requires the list form.
    const qExpr = `location ANY_OF [${locationId}]`;
    const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder`;
    const queryParams = { q: qExpr, limit: "100" };
    const qs = `q=${encodeURIComponent(qExpr)}&limit=100`;
    const fullUrl = `${baseUrl}?${qs}`;
    const authHeader = generateOAuthHeader("GET", baseUrl, queryParams, config);

    const listResp = await fetch(fullUrl, {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const listText = await listResp.text();
    let listData = null;
    if (listText) {
      try { listData = JSON.parse(listText); } catch { listData = null; }
    }
    if (!listResp.ok) {
      console.error(`transferOrder list failed:`, listResp.status, listText.slice(0, 800));
      return res.status(listResp.status).json({
        error: `NetSuite returned ${listResp.status}`,
        details: listData || listText,
      });
    }

    // Response shape: { totalResults, count, hasMore, items: [{ id, links: [...] }] }
    const listItems = Array.isArray(listData?.items) ? listData.items : [];
    if (listItems.length === 0) {
      return res.status(200).json({ orders: [] });
    }

    // ─── Step 2: fetch each TO's header fields in parallel ───
    // The list response only gives { id, links }. We need tranId, status,
    // location, transferLocation, trandate. Fetch minimal fields per record
    // using ?fields=... to keep payload small.
    const fieldList = "id,tranId,tranDate,status,location,transferLocation";
    const detailPromises = listItems.map(async (item) => {
      const id = item.id;
      if (!id) return null;
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
    // REST returns status either as a string enum value ("partiallyFulfilled")
    // or as { id, refName } where id is the enum value. Normalize either way.
    // Also accept the display-name form ("Partially Fulfilled") that the REST
    // API sometimes returns under refName only.
    const openStatusKeys = new Set([
      ...OPEN_STATUSES,                                    // enum form
      ...OPEN_STATUSES.map((s) => s.toLowerCase()),        // belt + suspenders
      "pending fulfillment",                               // display name forms
      "partially fulfilled",
    ]);
    const isOpen = (to) => {
      const raw = to.status;
      const candidates = [];
      if (typeof raw === "string") candidates.push(raw);
      if (raw && typeof raw === "object") {
        if (raw.id) candidates.push(String(raw.id));
        if (raw.refName) candidates.push(String(raw.refName));
      }
      return candidates.some((c) => openStatusKeys.has(c) || openStatusKeys.has(c.toLowerCase()));
    };
    const tos = allTos.filter(isOpen);

    // ─── Step 4: lock-state merge via KV ───
    const sessions = await Promise.all(
      tos.map((to) => kv.get(KEY_SESSION_BY_TO(String(to.id))))
    );

    // ─── Shape response per §4.1 ───
    // lineCount / totalQty are omitted (set to null) — aggregating those
    // across many TOs would require N extra record fetches. Session 4+
    // can add them per-row on demand if the UI needs them.
    const orders = tos.map((to, i) => {
      const sess = sessions[i];
      const srcLoc = to.location || {};
      const dstLoc = to.transferLocation || {};
      const rawStatus = to.status;
      const statusName = typeof rawStatus === "string" ? rawStatus : rawStatus?.refName || null;
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

    // Keep latest first — NS default order may already be this, but be explicit.
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
