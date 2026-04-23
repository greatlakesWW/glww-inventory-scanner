import { kv } from "@vercel/kv";
import { getSuiteQLConfig, runSuiteQL } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";
import {
  getSessionBySessionId,
  writeSession,
  deleteSession,
} from "../../_kv.js";

// ═══════════════════════════════════════════════════════════
// POST /api/transfer-orders/:id/fulfill  (Session 6, spec §4.6)
//
// Two-step NetSuite write:
//   1. POST .../transferOrder/{id}/!transform/itemFulfillment  — creates
//      the Item Fulfillment with per-bin inventoryDetail.
//   2. POST .../itemFulfillment/{ffId}/!transform/itemReceipt  — creates
//      the Item Receipt landing stock into the destination salesfloor bin.
//
// Between 1 and 2 we persist fulfillmentId into the KV session so the
// stuck-TO recovery path (Session 7) can re-attempt step 2 against a
// known fulfillment. Skipping this persist is how you lose inventory in
// the books — do not reorder.
//
// On full success: session is deleted from KV.
// On receipt failure: session transitions to fulfilled_pending_receipt
// and returns 207. Client renders a "stuck" card until Session 7 ships
// the retry UI.
// ═══════════════════════════════════════════════════════════

const ERROR_LOG_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days per spec §4.8

// Hardcoded GLWW default: location 3 = Sales Floor → bin F-01-0001.
// Can be overridden by the NS_SALESFLOOR_BINS_JSON env var if the setup
// ever changes or a new destination location needs to be added.
const SALESFLOOR_BIN_DEFAULTS = {
  "3": "F-01-0001",
};

function parseSalesfloorBins() {
  const raw = process.env.NS_SALESFLOOR_BINS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        // Merge env-var entries on top of the hardcoded defaults so the
        // env var can add or override locations without losing the base.
        return { ...SALESFLOOR_BIN_DEFAULTS, ...parsed };
      }
    } catch (_) {
      // Malformed env var: fall back to defaults. Logged so ops can fix it.
      console.warn("NS_SALESFLOOR_BINS_JSON is not valid JSON; using hardcoded defaults");
    }
  }
  return SALESFLOOR_BIN_DEFAULTS;
}

async function readJsonResp(resp) {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function nsGet(url, config) {
  // OAuth 1.0a signed GET. queryParams must be the parsed version of
  // whatever's after '?'; see api/record.js for the established pattern.
  const [baseUrl, queryString] = url.split("?");
  const queryParams = {};
  if (queryString) {
    for (const pair of queryString.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) queryParams[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }
  const authHeader = generateOAuthHeader("GET", baseUrl, queryParams, config);
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader },
  });
  return resp;
}

// Write a minimal error record to KV for post-mortem. Session 7 will
// evolve this into the structured schema documented in spec §4.8.
async function logFulfillmentError(entry) {
  try {
    const key = `error:fulfillment:${Date.now()}:${entry.toId}`;
    await kv.set(key, entry, { ex: ERROR_LOG_TTL_SECONDS });
  } catch (e) {
    // Never throw from logging — if KV write fails we console.error and continue.
    console.error("logFulfillmentError failed:", e);
  }
}

export default async function handler(req, res) {
  // ─── CORS ───
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const rawToId = req.query?.id;
  if (!rawToId || typeof rawToId !== "string") {
    return res.status(400).json({ error: "Missing ':id' path parameter" });
  }
  const toId = Number(rawToId);
  if (!Number.isInteger(toId) || toId <= 0) {
    return res.status(400).json({ error: "':id' must be a positive integer" });
  }

  const body = req.body || {};
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return res.status(400).json({ error: "Missing 'sessionId' in request body" });
  }

  // ─── Credentials up-front (throws 500 with helpful message if missing) ───
  let config;
  try {
    config = getSuiteQLConfig();
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  // ─── Session lookup + ownership wiring ───
  let session;
  try {
    session = await getSessionBySessionId(sessionId);
  } catch (e) {
    return res.status(500).json({ error: `KV read failed: ${e.message}` });
  }
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  if (String(session.toId) !== String(toId)) {
    return res.status(400).json({
      error: "Session does not belong to this TO",
      details: { sessionToId: session.toId, urlToId: toId },
    });
  }
  if (session.status === "fulfilled_pending_receipt") {
    // Session 6 does not handle retry of a stuck TO. Tell the caller to
    // use the dedicated retry endpoint (Session 7) once it exists.
    return res.status(409).json({
      error: "Session already in fulfilled_pending_receipt state — use retry-receipt",
      fulfillmentId: session.fulfillmentId || null,
    });
  }

  // ─── Reduce scan events → per-line / per-bin rollups ───
  // lineRoll[lineId] = { totalQty, binCounts: { [binId]: qty } }
  const lineRoll = {};
  for (const ev of Array.isArray(session.events) ? session.events : []) {
    if (!ev || ev.type !== "scan") continue;
    const lid = String(ev.lineId);
    const bid = ev.binId != null ? String(ev.binId) : "";
    const qty = Number(ev.qty) || 0;
    if (!qty) continue;
    if (!lineRoll[lid]) lineRoll[lid] = { totalQty: 0, binCounts: {} };
    lineRoll[lid].totalQty += qty;
    lineRoll[lid].binCounts[bid] = (lineRoll[lid].binCounts[bid] || 0) + qty;
  }

  if (Object.keys(lineRoll).length === 0) {
    return res.status(400).json({ error: "No scanned items on this session yet" });
  }

  // ─── Load TO header + lines via REST Record API ───
  // Get TO header + line sublist via REST Record API.
  //
  // We can't use SuiteQL here: transactionline.quantityfulfilled is
  // NOT_EXPOSED to SuiteQL's SEARCH channel in this account (verified
  // across Sessions 2 and 6). REST Record API returns it natively.
  const toUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder/${toId}?expandSubResources=true`;
  let to;
  try {
    const toResp = await nsGet(toUrl, config);
    const toData = await readJsonResp(toResp);
    if (!toResp.ok) {
      return res.status(toResp.status || 500).json({
        error: `NetSuite TO fetch returned ${toResp.status}`,
        details: toData,
      });
    }
    to = toData;
  } catch (e) {
    return res.status(500).json({ error: `TO fetch failed: ${e.message}` });
  }
  if (!to || typeof to !== "object") {
    return res.status(502).json({ error: "NetSuite returned unexpected TO payload" });
  }

  const destLoc = to.transferLocation || {};
  const destinationLocationId = destLoc.id != null ? String(destLoc.id) : null;
  if (!destinationLocationId) {
    return res.status(502).json({ error: "TO has no destination location" });
  }

  // Build lineMeta keyed by `l.line` — the REST Record API's line
  // identifier. Session events' `lineId` came from Session 2's detail
  // endpoint, which also reads `l.line` from REST, so they match.
  //
  // NOTE on orderLine offset: NetSuite stores each inventory item as
  // THREE sub-rows in transactionline (SuiteQL returns tl.id = 1,2,3
  // for item A; 4,5,6 for item B; etc.). REST's `l.line` is the first
  // of each triple (1, 4, 7...). But `!transform/itemFulfillment`
  // expects `orderLine` to be the MIDDLE sub-row (2, 5, 8...), which
  // we confirmed against an existing fulfillment on this TO
  // (IF2921, item/2 → orderLine=2, corresponding to TO line 1).
  // Offset is `l.line + 1`. Production TransferOrders.jsx uses SuiteQL
  // `linesequencenumber` which returns 2, 5, 8... directly — same end
  // result. Once SuiteQL can query `quantityfulfilled` again we can
  // source these directly; for now the +1 offset is reliable for
  // standard TO line structure.
  const rawLines = Array.isArray(to.item?.items)
    ? to.item.items
    : Array.isArray(to.item)
      ? to.item
      : [];
  const lineMeta = {};
  for (const l of rawLines) {
    if (l?.line == null) continue;
    lineMeta[String(l.line)] = {
      orderLine: Number(l.line) + 1, // transform line-offset; see note above
      itemId: l.item?.id != null ? String(l.item.id) : null,
      quantity: Number(l.quantity) || 0,
      quantityFulfilled: Number(l.quantityFulfilled) || 0,
    };
  }

  // Resolve destination bin. Defaults to the hardcoded GLWW map (location 3
  // → F-01-0001); NS_SALESFLOOR_BINS_JSON can add or override entries.
  const salesfloorMap = parseSalesfloorBins();
  if (!salesfloorMap || !salesfloorMap[destinationLocationId]) {
    return res.status(500).json({
      error:
        "No salesfloor bin configured for destination location " +
        destinationLocationId +
        '. Add it via NS_SALESFLOOR_BINS_JSON env var (e.g. {"' +
        destinationLocationId +
        '":"BIN-NUMBER"}) or extend SALESFLOOR_BIN_DEFAULTS in api/transfer-orders/[id]/fulfill.js.',
    });
  }
  const destBinNumber = String(salesfloorMap[destinationLocationId]);

  // ─── STEP 7: Create Item Fulfillment via RESTlet ───
  //
  // We used to POST `!transform/itemFulfillment` via the REST Record API,
  // but NS treats the pre-populated inventoryDetail as static and either
  // ignores our override or sums our qty with its auto-allocation,
  // producing "total inventory detail quantity must be N" errors. The
  // RESTlet uses SuiteScript's dynamic record API (select-line /
  // commit-line) which can remove the pre-populated assignments before
  // adding ours, and can set shipstatus=C in the same save so the TO
  // flips to "Pending Receipt" for the subsequent TO→IR transform.
  const restletUrl = process.env.NS_RESTLET_RECEIVE_TO_URL;
  if (!restletUrl) {
    return res.status(500).json({
      error: "NS_RESTLET_RECEIVE_TO_URL is not configured. See netsuite/README.md.",
    });
  }

  function signRestletAuth() {
    const [base, qs] = restletUrl.split("?");
    const qp = {};
    if (qs) {
      for (const pair of qs.split("&")) {
        const [k, ...rest] = pair.split("=");
        if (k) qp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
      }
    }
    return { base, auth: generateOAuthHeader("POST", base, qp, config) };
  }

  const fulfillLines = [];
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (!meta?.itemId) continue;
    const bins = Object.entries(roll.binCounts)
      .filter(([bid, q]) => bid && Number(q) > 0)
      .map(([bid, q]) => ({ binId: String(bid), quantity: Number(q) }));
    if (bins.length === 0) continue;
    fulfillLines.push({ itemId: String(meta.itemId), bins });
  }
  if (fulfillLines.length === 0) {
    return res.status(400).json({ error: "No scanned items match remaining lines on this TO" });
  }

  const fulfillBody = {
    transferOrderId: String(toId),
    action: "fulfill",
    lines: fulfillLines,
  };

  let fulfillmentId = null;
  try {
    const { base: ffBase, auth: ffAuth } = signRestletAuth();
    const ffResp = await fetch(restletUrl, {
      method: "POST",
      headers: { Authorization: ffAuth, "Content-Type": "application/json" },
      body: JSON.stringify(fulfillBody),
    });
    const ffText = await ffResp.text();
    let ffData = null;
    if (ffText) { try { ffData = JSON.parse(ffText); } catch { ffData = ffText; } }

    if (!ffResp.ok || !ffData?.fulfillmentId) {
      console.error("RESTlet fulfill failed:", ffResp.status, ffText.slice(0, 800));
      console.error("RESTlet fulfill payload:", JSON.stringify(fulfillBody));
      await logFulfillmentError({
        timestamp: new Date().toISOString(),
        toId: String(toId),
        tranId: to.tranId || null,
        sessionId: session.sessionId,
        pickerName: session.pickerName || null,
        step: "item_fulfillment_restlet",
        fulfillmentId: null,
        netsuite: {
          status: ffResp.status,
          statusText: ffResp.statusText || "",
          url: ffBase,
          body: ffData,
        },
        requestPayload: fulfillBody,
      });
      return res.status(ffResp.status || 500).json({
        error: "Item Fulfillment create failed",
        details: ffData,
      });
    }
    fulfillmentId = String(ffData.fulfillmentId);
  } catch (e) {
    return res.status(500).json({ error: `RESTlet fulfill threw: ${e.message}` });
  }

  // ─── STEP 8: Persist fulfillmentId before attempting receipt ───
  // Safety wire. Without this, a crash between fulfillment and receipt
  // leaves an orphan IF with no way for retry-receipt to find it.
  try {
    await writeSession({
      ...session,
      fulfillmentId,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Failed to persist fulfillmentId to session:", e);
  }

  // ─── STEP 9: Receipt via RESTlet (same RESTlet, action=receive) ───

  // Resolve destination bin NAME → internal ID via SuiteQL (the RESTlet
  // takes a bin internal id, not a name).
  let destBinId = null;
  try {
    const binQ = `SELECT id, binnumber FROM Bin WHERE binnumber = '${destBinNumber.replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
    const { items: binRows } = await runSuiteQL(binQ);
    if (binRows && binRows[0]?.id != null) destBinId = String(binRows[0].id);
  } catch (e) {
    console.error("Destination bin lookup failed:", e.message);
  }
  if (!destBinId) {
    try {
      await writeSession({
        ...session,
        fulfillmentId,
        status: "fulfilled_pending_receipt",
        updatedAt: new Date().toISOString(),
      });
    } catch {}
    return res.status(207).json({
      status: "partial_success",
      fulfillmentId,
      errorMessage: `Could not resolve destination bin "${destBinNumber}" to an internal ID. Check the bin exists at location ${destinationLocationId}.`,
      retryUrl: `/api/transfer-orders/${toId}/retry-receipt`,
    });
  }

  // Build RESTlet payload. The RESTlet transforms TO → IR (the only
  // programmatic receipt path this NS account permits; see the probe
  // matrix in commit 586bab4). Receipt sublist rows are matched by
  // itemId, not by orderLine, because the orderline field on an IR's
  // sublist doesn't correspond to anything the caller has in hand —
  // itemId is what we actually know.
  const restletLines = [];
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (!meta?.itemId) continue;
    const q = Number(roll.totalQty) || 0;
    if (q <= 0) continue;
    restletLines.push({ itemId: String(meta.itemId), quantity: q });
  }

  const restletBody = {
    transferOrderId: String(toId),
    fulfillmentId: String(fulfillmentId),
    destBinId: String(destBinId),
    action: "receive",
    lines: restletLines,
  };

  let receiptId = null;
  try {
    const { base: restletBase, auth: restletAuth } = signRestletAuth();

    const restletResp = await fetch(restletUrl, {
      method: "POST",
      headers: {
        Authorization: restletAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(restletBody),
    });
    const restletText = await restletResp.text();
    let restletData = null;
    if (restletText) {
      try { restletData = JSON.parse(restletText); } catch { restletData = restletText; }
    }

    if (!restletResp.ok || !restletData?.receiptId) {
      console.error("RESTlet receipt create failed:", restletResp.status, restletText.slice(0, 800));
      console.error("RESTlet request payload:", JSON.stringify(restletBody));

      const errorMessage =
        (restletData && typeof restletData === "object" &&
          (restletData["o:errorDetails"]?.[0]?.detail ||
            restletData.error?.message ||
            restletData.message ||
            restletData.error)) ||
        (typeof restletData === "string" ? restletData.slice(0, 200) : null) ||
        `RESTlet returned ${restletResp.status}`;

      try {
        await writeSession({
          ...session,
          fulfillmentId,
          status: "fulfilled_pending_receipt",
          updatedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error("Failed to set session fulfilled_pending_receipt:", e);
      }

      await logFulfillmentError({
        timestamp: new Date().toISOString(),
        toId: String(toId),
        tranId: to.tranId || null,
        sessionId: session.sessionId,
        pickerName: session.pickerName || null,
        step: "item_receipt_restlet",
        fulfillmentId,
        isRetry: false,
        netsuite: {
          status: restletResp.status,
          statusText: restletResp.statusText || "",
          url: restletBase,
          body: restletData,
        },
        requestPayload: restletBody,
      });

      return res.status(207).json({
        status: "partial_success",
        fulfillmentId,
        errorMessage,
        retryUrl: `/api/transfer-orders/${toId}/retry-receipt`,
      });
    }

    receiptId = String(restletData.receiptId);
  } catch (e) {
    console.error("RESTlet call threw:", e.message);
    try {
      await writeSession({
        ...session,
        fulfillmentId,
        status: "fulfilled_pending_receipt",
        updatedAt: new Date().toISOString(),
      });
    } catch {}
    return res.status(207).json({
      status: "partial_success",
      fulfillmentId,
      errorMessage: `RESTlet call failed: ${e.message}`,
      retryUrl: `/api/transfer-orders/${toId}/retry-receipt`,
    });
  }

  // ─── Success: compute fullyFulfilled, delete session, return ───
  // "fullyFulfilled" = every eligible TO line is now complete.
  let fullyFulfilled = true;
  for (const [lid, meta] of Object.entries(lineMeta)) {
    const remaining = meta.quantity - meta.quantityFulfilled; // before this fulfillment
    const pickedHere = lineRoll[lid]?.totalQty || 0;
    if (pickedHere < remaining) { fullyFulfilled = false; break; }
  }

  try {
    await deleteSession(session);
  } catch (e) {
    // Deletion failure isn't fatal — session will TTL out after 48h. Log and proceed.
    console.error("deleteSession after fulfill failed:", e);
  }

  return res.status(200).json({
    fulfillmentId,
    receiptId,
    fullyFulfilled,
    tranId: to.tranId || null,
  });
}
