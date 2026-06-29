import { getSuiteQLConfig } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";

// ═══════════════════════════════════════════════════════════
// POST /api/sales-orders/:id/split-fulfill
//
// Fulfills ONE Sales Order line across multiple locations by calling
// the fulfillSalesOrder RESTlet once per location, sequentially, each
// with a location override. The first calls leave the SO Partially
// Fulfilled; the last call (when it completes the order) sets shipped.
//
// Body:
// {
//   "itemId": "100",
//   "allocations": [
//     { "locationId": "2", "bins": [ { "binId": "4001", "quantity": 1 } ] },
//     { "locationId": "1", "bins": [ { "binId": "F-01", "quantity": 1 } ] }
//   ],
//   "completesOrder": true   // if true, the final call sets shipped
// }
//
// Sequential calls avoid RCRD_HAS_BEEN_CHANGED contention. Partial
// success is reported, never hidden.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const soId = req.query?.id;
  if (!soId || typeof soId !== "string") {
    return res.status(400).json({ error: "Missing sessionId path param" });
  }

  const restletUrl = process.env.NS_RESTLET_FULFILL_SO_URL;
  if (!restletUrl) {
    return res.status(500).json({ error: "NS_RESTLET_FULFILL_SO_URL is not configured." });
  }

  let config;
  try { config = getSuiteQLConfig(); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  const body = req.body || {};
  const itemId = body.itemId != null ? String(body.itemId) : "";
  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const completesOrder = !!body.completesOrder;
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  if (allocations.length === 0) return res.status(400).json({ error: "allocations[] must be non-empty" });

  const [restletBase, restletQs] = restletUrl.split("?");
  const restletQp = {};
  if (restletQs) {
    for (const pair of restletQs.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) restletQp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }

  const results = [];
  let anySuccess = false;
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const isLast = i === allocations.length - 1;
    const locId = a.locationId != null ? String(a.locationId) : "";
    const bins = Array.isArray(a.bins) ? a.bins : [];
    const qty = bins.reduce((s, b) => s + (Number(b.quantity) || 0), 0);
    if (!locId || qty <= 0) {
      results.push({ locationId: locId, status: "skipped_empty", fulfillmentId: null });
      continue;
    }

    const restletBody = {
      salesOrderId: soId,
      setShipped: completesOrder && isLast,
      lines: [{ itemId, locationId: locId, bins }],
    };

    try {
      const auth = generateOAuthHeader("POST", restletBase, restletQp, config);
      const resp = await fetch(restletUrl, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(restletBody),
      });
      const text = await resp.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!resp.ok || !data?.fulfillmentId) {
        const error = (typeof data === "object" && (data?.["o:errorDetails"]?.[0]?.detail || data?.error?.message || data?.message)) ||
                      (typeof data === "string" ? data.slice(0, 300) : `RESTlet returned ${resp.status}`);
        results.push({ locationId: locId, qty, status: "error", error, fulfillmentId: null });
        continue;
      }
      anySuccess = true;
      results.push({ locationId: locId, qty, status: "fulfilled", fulfillmentId: String(data.fulfillmentId) });
    } catch (e) {
      results.push({ locationId: locId, qty, status: "error", error: `RESTlet call threw: ${e.message}`, fulfillmentId: null });
    }
  }

  const allOk = results.every((r) => r.status === "fulfilled");
  return res.status(anySuccess ? 200 : 500).json({
    status: allOk ? "complete" : anySuccess ? "partial" : "failed",
    soId,
    itemId,
    results,
  });
}
