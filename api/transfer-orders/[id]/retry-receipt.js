import { kv } from "@vercel/kv";
import { getSuiteQLConfig, runSuiteQL } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";
import {
  getSessionBySessionId,
  getSessionByToId,
  writeSession,
  deleteSession,
} from "../../_kv.js";

// ═══════════════════════════════════════════════════════════
// POST /api/transfer-orders/:id/retry-receipt
//
// Re-runs the receipt step for a session in fulfilled_pending_receipt
// state. The Item Fulfillment already exists in NetSuite — we just
// need to create the matching Item Receipt.
//
// Two ways to identify the session:
//   1. Preferred: body includes { "sessionId": "sess_..." }
//   2. Fallback: no body (or empty) — we look up the active session
//      for this TO via KV's primary key `session:to:{id}`.
//
// The (2) path is how an admin manually unsticks a TO via curl without
// needing to fish the sessionId out of KV.
// ═══════════════════════════════════════════════════════════

const ERROR_LOG_TTL_SECONDS = 60 * 60 * 24 * 30;
const SALESFLOOR_BIN_DEFAULTS = { "3": "F-01-0001" };

function parseSalesfloorBins() {
  const raw = process.env.NS_SALESFLOOR_BINS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { ...SALESFLOOR_BIN_DEFAULTS, ...parsed };
      }
    } catch { }
  }
  return SALESFLOOR_BIN_DEFAULTS;
}

async function readJsonResp(resp) {
  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function nsGet(url, config) {
  const [baseUrl, queryString] = url.split("?");
  const queryParams = {};
  if (queryString) {
    for (const pair of queryString.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) queryParams[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }
  const authHeader = generateOAuthHeader("GET", baseUrl, queryParams, config);
  return fetch(url, { method: "GET", headers: { Authorization: authHeader } });
}

async function logFulfillmentError(entry) {
  try {
    const key = `error:fulfillment:${Date.now()}:${entry.toId}`;
    await kv.set(key, entry, { ex: ERROR_LOG_TTL_SECONDS });
  } catch (e) {
    console.error("logFulfillmentError failed:", e);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const rawToId = req.query?.id;
  if (!rawToId || typeof rawToId !== "string") {
    return res.status(400).json({ error: "Missing ':id' path parameter" });
  }
  const toId = Number(rawToId);
  if (!Number.isInteger(toId) || toId <= 0) {
    return res.status(400).json({ error: "':id' must be a positive integer" });
  }

  const body = req.body || {};
  const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

  let config;
  try {
    config = getSuiteQLConfig();
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  // ─── Load session ───
  let session = null;
  try {
    session = requestedSessionId
      ? await getSessionBySessionId(requestedSessionId)
      : await getSessionByToId(String(toId));
  } catch (e) {
    return res.status(500).json({ error: `KV read failed: ${e.message}` });
  }
  if (!session) {
    return res.status(404).json({
      error: requestedSessionId
        ? "Session not found"
        : `No active session found for TO ${toId}`,
    });
  }
  if (String(session.toId) !== String(toId)) {
    return res.status(400).json({
      error: "Session does not belong to this TO",
      details: { sessionToId: session.toId, urlToId: toId },
    });
  }
  if (session.status !== "fulfilled_pending_receipt") {
    return res.status(409).json({
      error: `Session status is "${session.status}", expected "fulfilled_pending_receipt"`,
      sessionId: session.sessionId,
      fulfillmentId: session.fulfillmentId || null,
    });
  }
  const fulfillmentId = session.fulfillmentId;
  if (!fulfillmentId) {
    return res.status(409).json({
      error: "Session is marked stuck but has no fulfillmentId — cannot retry",
      sessionId: session.sessionId,
    });
  }

  // ─── Roll up session scans by itemId ───
  // We match picked items to IF sublist lines by itemId, not by session
  // lineId. This avoids needing the TO's line metadata at all — the RESTlet
  // now transforms from the IF, and the IF's sublist already enumerates
  // exactly the in-transit lines we need to receive.
  const qtyByItemId = {};
  for (const ev of Array.isArray(session.events) ? session.events : []) {
    if (!ev || ev.type !== "scan") continue;
    const iid = ev.itemId != null ? String(ev.itemId) : "";
    const qty = Number(ev.qty) || 0;
    if (!iid || !qty) continue;
    qtyByItemId[iid] = (qtyByItemId[iid] || 0) + qty;
  }
  if (Object.keys(qtyByItemId).length === 0) {
    return res.status(400).json({ error: "No scan events on session to receive" });
  }

  // ─── Load TO header (for destination location + tranId) ───
  const toUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder/${toId}?fields=id,tranId,transferLocation`;
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

  const destLoc = to.transferLocation || {};
  const destinationLocationId = destLoc.id != null ? String(destLoc.id) : null;
  if (!destinationLocationId) {
    return res.status(502).json({ error: "TO has no destination location" });
  }

  // Resolve destination bin
  const salesfloorMap = parseSalesfloorBins();
  const destBinNumber = salesfloorMap[destinationLocationId];
  if (!destBinNumber) {
    return res.status(500).json({
      error: `No salesfloor bin configured for destination location ${destinationLocationId}`,
    });
  }

  let destBinId = null;
  try {
    const binQ = `SELECT id, binnumber FROM Bin WHERE binnumber = '${String(destBinNumber).replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
    const { items: binRows } = await runSuiteQL(binQ);
    if (binRows && binRows[0]?.id != null) destBinId = String(binRows[0].id);
  } catch (e) {
    console.error("Destination bin lookup failed:", e.message);
  }
  if (!destBinId) {
    return res.status(500).json({
      error: `Could not resolve bin "${destBinNumber}" to internal ID`,
    });
  }

  // ─── Ensure IF is in Shipped status (shipStatus=C) ───
  try {
    const patchUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/itemFulfillment/${fulfillmentId}`;
    const patchAuth = generateOAuthHeader("PATCH", patchUrl, {}, config);
    const patchResp = await fetch(patchUrl, {
      method: "PATCH",
      headers: { Authorization: patchAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ shipStatus: "C" }),
    });
    if (!patchResp.ok) {
      const t = await patchResp.text();
      console.warn("shipStatus PATCH non-2xx (may already be Shipped):", patchResp.status, t.slice(0, 300));
    }
  } catch (e) {
    console.warn("shipStatus PATCH threw:", e.message);
  }

  // ─── Call RESTlet ───
  const restletUrl = process.env.NS_RESTLET_RECEIVE_TO_URL;
  if (!restletUrl) {
    return res.status(500).json({
      error: "NS_RESTLET_RECEIVE_TO_URL is not configured. See netsuite/README.md.",
    });
  }

  // The RESTlet matches receipt sublist rows by itemId (see the probe
  // matrix in commit 586bab4 for why we use TO→IR transform, not IF→IR).
  const restletLines = Object.entries(qtyByItemId).map(([itemId, quantity]) => ({
    itemId,
    quantity,
  }));

  const restletBody = {
    transferOrderId: String(toId),
    fulfillmentId: String(fulfillmentId),
    destBinId,
    action: "receive",
    lines: restletLines,
  };

  try {
    const [restletBase, restletQs] = restletUrl.split("?");
    const restletQp = {};
    if (restletQs) {
      for (const pair of restletQs.split("&")) {
        const [k, ...rest] = pair.split("=");
        if (k) restletQp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
      }
    }
    const restletAuth = generateOAuthHeader("POST", restletBase, restletQp, config);

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
      console.error("Retry RESTlet failed:", restletResp.status, restletText.slice(0, 800));
      console.error("Retry request payload:", JSON.stringify(restletBody));
      await logFulfillmentError({
        timestamp: new Date().toISOString(),
        toId: String(toId),
        tranId: to.tranId || null,
        sessionId: session.sessionId,
        pickerName: session.pickerName || null,
        step: "item_receipt_restlet_retry",
        fulfillmentId,
        isRetry: true,
        netsuite: {
          status: restletResp.status,
          statusText: restletResp.statusText || "",
          url: restletBase,
          body: restletData,
        },
        requestPayload: restletBody,
      });

      return res.status(restletResp.status || 500).json({
        error: "RESTlet receipt retry failed",
        details: restletData,
        fulfillmentId,
      });
    }

    const receiptId = String(restletData.receiptId);

    // Success — clean up session
    try {
      await deleteSession(session);
    } catch (e) {
      console.error("deleteSession after retry failed:", e);
    }

    return res.status(200).json({
      status: "complete",
      fulfillmentId,
      receiptId,
      tranId: to.tranId || null,
    });
  } catch (e) {
    console.error("Retry RESTlet call threw:", e.message);
    return res.status(500).json({
      error: `RESTlet call failed: ${e.message}`,
      fulfillmentId,
    });
  }
}
