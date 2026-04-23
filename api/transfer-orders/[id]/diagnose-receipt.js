import { getSuiteQLConfig, runSuiteQL } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";

// ═══════════════════════════════════════════════════════════
// POST /api/transfer-orders/:id/diagnose-receipt
//
// Thin passthrough to the receiveTransferOrder RESTlet. No session
// lookup, no KV writes. Two modes:
//
//   1. Diagnose mode — body: { "fulfillmentId": "526977" }
//      Sends diagnose:true to the RESTlet. Returns the probe matrix
//      and NS runtime state. Used to investigate which programmatic
//      IR paths (if any) this account permits.
//
//   2. Manual receipt mode — body: {
//        "fulfillmentId": "526977",
//        "destBinNumber": "F-01-0001",   // or destBinId directly
//        "lines": [ { "itemId": "123", "quantity": 1 } ]
//      }
//      Used by an admin to receive a specific IF without going through
//      the picker session flow (e.g. to clean up a stuck IF, or to
//      test the end-to-end path without putting a picker in front of
//      the app).
// ═══════════════════════════════════════════════════════════

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
  const fulfillmentId = typeof body.fulfillmentId === "string"
    ? body.fulfillmentId.trim()
    : String(body.fulfillmentId || "").trim();
  if (!fulfillmentId) {
    return res.status(400).json({ error: "Missing 'fulfillmentId' in body" });
  }

  let config;
  try {
    config = getSuiteQLConfig();
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }

  const restletUrl = process.env.NS_RESTLET_RECEIVE_TO_URL;
  if (!restletUrl) {
    return res.status(500).json({ error: "NS_RESTLET_RECEIVE_TO_URL is not configured" });
  }

  // Determine mode: if caller provided lines[] + a bin, this is a real
  // receipt request; otherwise it's a diagnostic probe.
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const hasLines = rawLines.length > 0;
  const destBinNumber = typeof body.destBinNumber === "string" ? body.destBinNumber.trim() : "";
  const explicitDestBinId = body.destBinId != null ? String(body.destBinId) : "";

  let destBinId = explicitDestBinId;
  if (hasLines && !destBinId && destBinNumber) {
    try {
      const binQ = `SELECT id, binnumber FROM Bin WHERE binnumber = '${destBinNumber.replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
      const { items: binRows } = await runSuiteQL(binQ);
      if (binRows && binRows[0]?.id != null) destBinId = String(binRows[0].id);
    } catch (e) {
      return res.status(500).json({ error: `Bin lookup failed: ${e.message}` });
    }
    if (!destBinId) {
      return res.status(400).json({ error: `Bin "${destBinNumber}" not found` });
    }
  }
  if (hasLines && !destBinId) {
    return res.status(400).json({ error: "Manual receipt requires destBinNumber or destBinId" });
  }

  const [restletBase, restletQs] = restletUrl.split("?");
  const restletQp = {};
  if (restletQs) {
    for (const pair of restletQs.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) restletQp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }
  const restletAuth = generateOAuthHeader("POST", restletBase, restletQp, config);

  const payload = hasLines
    ? {
        transferOrderId: String(toId),
        fulfillmentId,
        destBinId,
        lines: rawLines.map((l) => ({
          itemId: String(l.itemId),
          quantity: Number(l.quantity),
        })),
      }
    : {
        transferOrderId: String(toId),
        fulfillmentId,
        diagnose: true,
      };

  try {
    const resp = await fetch(restletUrl, {
      method: "POST",
      headers: {
        Authorization: restletAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    return res.status(resp.ok ? 200 : (resp.status || 500)).json({
      restletStatus: resp.status,
      restletOk: resp.ok,
      response: data,
      sentPayload: payload,
    });
  } catch (e) {
    return res.status(500).json({ error: `RESTlet call threw: ${e.message}` });
  }
}
