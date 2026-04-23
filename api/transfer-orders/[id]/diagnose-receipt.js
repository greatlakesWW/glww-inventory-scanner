import { getSuiteQLConfig } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";

// ═══════════════════════════════════════════════════════════
// POST /api/transfer-orders/:id/diagnose-receipt
//
// One-shot endpoint that calls the receiveTransferOrder RESTlet with
// diagnose:true and returns the raw JSON response. Used exactly once to
// confirm which TO→IR programmatic path (if any) this NS account
// permits. No session lookup, no KV writes — pure passthrough.
//
// Body: { "fulfillmentId": "526977" }   required
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

  const [restletBase, restletQs] = restletUrl.split("?");
  const restletQp = {};
  if (restletQs) {
    for (const pair of restletQs.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) restletQp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }
  const restletAuth = generateOAuthHeader("POST", restletBase, restletQp, config);

  const payload = {
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
