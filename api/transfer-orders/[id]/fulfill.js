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

// Extract the numeric record id from NetSuite's Location header.
// Example: "https://acct.suitetalk.api.netsuite.com/services/rest/record/v1/itemFulfillment/54321"
function extractRecordId(locationHeader) {
  if (!locationHeader) return null;
  const m = String(locationHeader).match(/\/(\d+)(?:[?#].*)?$/);
  return m ? m[1] : null;
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

async function nsPost(url, body, config) {
  // For POST with no query string (the transform endpoints), queryParams is {}.
  const authHeader = generateOAuthHeader("POST", url, {}, config);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
  // `orderLine` on the fulfillment transform payload uses the same value.
  const rawLines = Array.isArray(to.item?.items)
    ? to.item.items
    : Array.isArray(to.item)
      ? to.item
      : [];
  const lineMeta = {};
  for (const l of rawLines) {
    if (l?.line == null) continue;
    lineMeta[String(l.line)] = {
      orderLine: Number(l.line),
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

  // Note: we previously resolved session binId → binNumber via inventorybalance
  // so we could hand-pick source bins on the Item Fulfillment. That got
  // rejected by NetSuite with USER_ERROR on the item sublist (the transform's
  // inventoryAssignment is static). Production TransferOrders.jsx also omits
  // inventoryDetail on the fulfillment and lets NetSuite auto-allocate source
  // bins, which is what we now do too. The session still records which bins
  // the picker physically pulled from (event log in KV) for audit purposes.

  // ─── Build Item Fulfillment payload ───
  //
  // Only send entries for lines the picker actually scanned. NS's
  // !transform/itemFulfillment pre-populates the fulfillment sublist with
  // every eligible (remaining > 0) line at default qty — we MODIFY those
  // defaults via `orderLine`. Lines we don't include in the payload retain
  // their defaults...which would fulfill stock we didn't pick. So we also
  // override un-picked lines to zero via itemreceive:false.
  //
  // CRITICAL NOTE FOR DEBUGGING: the prior iteration included zero stubs
  // for every "remaining" line we computed from the TO, which triggered a
  // 400 "non-existent line / static sublist" error. The likely cause was
  // our definition of "remaining" not matching NS's. This iteration sends
  // stubs for every rawLine whose quantity > quantityFulfilled (exactly
  // what REST reports), without any additional filtering. If NS still
  // rejects it, the diagnostic logging below will show us exactly which
  // orderLine numbers NS considers invalid.
  const fulfillmentLines = [];
  // (a) the lines we picked — explicit qty + itemreceive:true
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (!meta) continue; // skip picks whose line isn't even on the TO anymore
    fulfillmentLines.push({
      orderLine: meta.orderLine,
      quantity: Number(roll.totalQty) || 0,
      itemreceive: (Number(roll.totalQty) || 0) > 0,
    });
  }

  if (fulfillmentLines.length === 0) {
    return res.status(400).json({
      error: "No scanned items match remaining lines on this TO",
    });
  }

  // (b) stubs for every OTHER eligible line so NS doesn't accidentally
  // auto-fulfill them at default qty. Skip lines with no meta.orderLine.
  const touchedLines = new Set(fulfillmentLines.map((l) => Number(l.orderLine)));
  for (const meta of Object.values(lineMeta)) {
    if (!meta.orderLine) continue;
    if (touchedLines.has(Number(meta.orderLine))) continue;
    const remaining = meta.quantity - meta.quantityFulfilled;
    if (remaining <= 0) continue; // already fulfilled — transform won't include
    fulfillmentLines.push({
      orderLine: meta.orderLine,
      quantity: 0,
      itemreceive: false,
    });
  }

  const fulfillmentPayload = { item: { items: fulfillmentLines } };

  // ─── STEP 7: POST Item Fulfillment ───
  const ffUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder/${toId}/!transform/itemFulfillment`;
  let fulfillmentId = null;
  try {
    const ffResp = await nsPost(ffUrl, fulfillmentPayload, config);
    const ffText = await ffResp.text();
    let ffData = null;
    if (ffText) { try { ffData = JSON.parse(ffText); } catch { ffData = ffText; } }
    if (!(ffResp.status === 204 || ffResp.status === 200 || ffResp.status === 201)) {
      console.error("Item Fulfillment create failed:", ffResp.status, ffText.slice(0, 600));
      console.error("Item Fulfillment request payload:", JSON.stringify(fulfillmentPayload));
      console.error("Item Fulfillment lineMeta summary:", JSON.stringify(lineMeta));
      console.error("Session lineRoll summary:", JSON.stringify(lineRoll));
      await logFulfillmentError({
        timestamp: new Date().toISOString(),
        toId: String(toId),
        tranId: to.tranId || null,
        sessionId: session.sessionId,
        pickerName: session.pickerName || null,
        step: "item_fulfillment",
        fulfillmentId: null,
        netsuite: {
          status: ffResp.status,
          statusText: ffResp.statusText || "",
          url: ffUrl,
          body: ffData,
        },
        requestPayload: fulfillmentPayload,
      });
      return res.status(ffResp.status || 500).json({
        error: `Item Fulfillment create failed (NS ${ffResp.status})`,
        details: ffData,
      });
    }
    fulfillmentId = extractRecordId(ffResp.headers.get("Location"));
    if (!fulfillmentId) {
      return res.status(502).json({
        error: "Item Fulfillment created but Location header missing fulfillment id",
      });
    }
  } catch (e) {
    return res.status(500).json({ error: `Item Fulfillment POST failed: ${e.message}` });
  }

  // ─── STEP 9: PERSIST fulfillmentId before attempting receipt ───
  // Safety wire. Without this, a crash between fulfillment create and
  // receipt create leaves an orphan fulfillment with no way for Session 7
  // to recover it.
  try {
    await writeSession({
      ...session,
      fulfillmentId,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    // Session write failed — log and continue. Worst case the retry-receipt
    // path will have to discover the fulfillment ID from NetSuite manually.
    console.error("Failed to persist fulfillmentId to session:", e);
  }

  // ─── STEP 10–11: Build and POST Item Receipt ───
  //
  // Same shape as the fulfillment: entries for scanned lines (with
  // inventoryDetail citing the destination bin) plus zero-qty stubs
  // for other eligible lines (so NS doesn't auto-receive them at
  // their default qty). The receipt transform's sublist mirrors the
  // fulfillment we just created.
  const receiptLines = [];
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (!meta) continue;
    const picked = Number(roll.totalQty) || 0;
    if (picked <= 0) continue;
    receiptLines.push({
      orderLine: meta.orderLine,
      quantity: picked,
      itemreceive: true,
      inventoryDetail: {
        inventoryAssignment: {
          items: [{ quantity: picked, binNumber: destBinNumber }],
        },
      },
    });
  }
  const touchedReceiptLines = new Set(receiptLines.map((l) => Number(l.orderLine)));
  for (const meta of Object.values(lineMeta)) {
    if (!meta.orderLine) continue;
    if (touchedReceiptLines.has(Number(meta.orderLine))) continue;
    const remaining = meta.quantity - meta.quantityFulfilled;
    if (remaining <= 0) continue;
    receiptLines.push({
      orderLine: meta.orderLine,
      quantity: 0,
      itemreceive: false,
    });
  }
  const receiptPayload = { item: { items: receiptLines } };

  const rcUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/itemFulfillment/${fulfillmentId}/!transform/itemReceipt`;

  let receiptId = null;
  try {
    const rcResp = await nsPost(rcUrl, receiptPayload, config);
    const rcText = await rcResp.text();
    let rcData = null;
    if (rcText) { try { rcData = JSON.parse(rcText); } catch { rcData = rcText; } }

    if (!(rcResp.status === 204 || rcResp.status === 200 || rcResp.status === 201)) {
      // STEP 13: receipt failure. Mark session stuck, log error, return 207.
      const errorMessage =
        (rcData && typeof rcData === "object" && (rcData.title || rcData.error)) ||
        `NetSuite returned ${rcResp.status}`;

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
        step: "item_receipt",
        fulfillmentId,
        isRetry: false,
        netsuite: {
          status: rcResp.status,
          statusText: rcResp.statusText || "",
          url: rcUrl,
          body: rcData,
        },
        requestPayload: receiptPayload,
      });

      return res.status(207).json({
        status: "partial_success",
        fulfillmentId,
        errorMessage,
        retryUrl: `/api/transfer-orders/${toId}/retry-receipt`,
      });
    }

    receiptId = extractRecordId(rcResp.headers.get("Location"));
  } catch (e) {
    return res.status(500).json({
      error: `Item Receipt POST failed: ${e.message}`,
      fulfillmentId,
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
