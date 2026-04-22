import { kv } from "@vercel/kv";
import { getSuiteQLConfig } from "../../_suiteql.js";
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

function parseSalesfloorBins() {
  const raw = process.env.NS_SALESFLOOR_BINS_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {
    // fall through
  }
  return null;
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
  // Need: destinationLocationId, per-line { orderLine, itemId }, and bin names
  // for each (item, binId) combination seen in lineRoll.
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

  // Flatten NS line sublist (expandSubResources packs them into to.item.items)
  const rawLines = Array.isArray(to.item?.items) ? to.item.items : Array.isArray(to.item) ? to.item : [];

  // Map lineId (string) -> { orderLine, itemId }
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

  // Resolve destination bin from env var.
  const salesfloorMap = parseSalesfloorBins();
  if (!salesfloorMap || !salesfloorMap[destinationLocationId]) {
    return res.status(500).json({
      error:
        "NS_SALESFLOOR_BINS_JSON missing or does not contain an entry for destination location " +
        destinationLocationId +
        '. Set the env var to e.g. {"3":"F-01-0001"} and redeploy.',
    });
  }
  const destBinNumber = String(salesfloorMap[destinationLocationId]);

  // ─── Resolve binId → binNumber via inventorybalance (batched) ───
  // Pull the bins we actually need. For each (item, binId) in lineRoll, we
  // want the human-readable bin name to put in inventoryAssignment.
  const itemIds = new Set();
  const binIds = new Set();
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (meta?.itemId) itemIds.add(meta.itemId);
    for (const bid of Object.keys(roll.binCounts)) {
      if (bid) binIds.add(bid);
    }
  }

  // Use inventorybalance to map (item, bin) -> bin_number. This is the same
  // table the picker's UI uses to display binAvailability, so it definitely
  // has rows for every bin the picker scanned from (they wouldn't have had
  // a bin chip otherwise).
  const binNameByBinId = {};
  if (itemIds.size > 0 && binIds.size > 0) {
    const itemList = [...itemIds].join(",");
    const binList = [...binIds].join(",");
    const query = `
      SELECT DISTINCT ib.binnumber AS bin_id, BUILTIN.DF(ib.binnumber) AS bin_number
      FROM inventorybalance ib
      WHERE ib.item IN (${itemList})
        AND ib.binnumber IN (${binList})
    `;
    try {
      const qUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0`;
      const authHeader = generateOAuthHeader("POST", qUrl.split("?")[0], { limit: "1000", offset: "0" }, config);
      const qResp = await fetch(qUrl, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json", Prefer: "transient" },
        body: JSON.stringify({ q: query }),
      });
      const qData = await readJsonResp(qResp);
      if (qResp.ok && qData?.items) {
        for (const r of qData.items) {
          if (r.bin_id != null && r.bin_number) binNameByBinId[String(r.bin_id)] = String(r.bin_number);
        }
      }
    } catch (e) {
      console.warn("bin-number lookup failed:", e.message);
    }
  }

  // ─── Build Item Fulfillment payload ───
  const fulfillmentLines = [];
  const missingBinNames = [];
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (!meta) continue;
    const assignments = [];
    for (const [bid, qty] of Object.entries(roll.binCounts)) {
      const binNumber = binNameByBinId[bid];
      if (!binNumber) {
        missingBinNames.push({ lineId: lid, binId: bid });
        continue;
      }
      assignments.push({ quantity: qty, binNumber });
    }
    if (assignments.length === 0) continue;
    fulfillmentLines.push({
      orderLine: meta.orderLine,
      quantity: roll.totalQty,
      itemreceive: true,
      inventoryDetail: { inventoryAssignment: { items: assignments } },
    });
  }

  if (missingBinNames.length > 0) {
    return res.status(500).json({
      error: "Could not resolve bin names for some picked bins",
      details: missingBinNames,
    });
  }
  if (fulfillmentLines.length === 0) {
    return res.status(400).json({ error: "No valid fulfillable lines after rollup" });
  }

  // Append itemreceive:false stubs for every TO line we're NOT fulfilling.
  // NetSuite's transform treats missing lines as "keep as-is," but including
  // the stubs makes the payload self-documenting and matches the existing
  // TransferOrders production pattern.
  const touchedLineIds = new Set(fulfillmentLines.map((e) => String(e.orderLine)));
  for (const meta of Object.values(lineMeta)) {
    if (touchedLineIds.has(String(meta.orderLine))) continue;
    fulfillmentLines.push({ orderLine: meta.orderLine, itemreceive: false });
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
  const receiptLines = [];
  for (const [lid, roll] of Object.entries(lineRoll)) {
    const meta = lineMeta[lid];
    if (!meta) continue;
    receiptLines.push({
      orderLine: meta.orderLine,
      quantity: roll.totalQty,
      itemreceive: true,
      inventoryDetail: {
        inventoryAssignment: {
          items: [{ quantity: roll.totalQty, binNumber: destBinNumber }],
        },
      },
    });
  }
  for (const meta of Object.values(lineMeta)) {
    if (receiptLines.some((e) => Number(e.orderLine) === Number(meta.orderLine))) continue;
    receiptLines.push({ orderLine: meta.orderLine, itemreceive: false });
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
