import { getConfig, generateOAuthHeader } from "./_auth.js";
import { runSuiteQL } from "./_suiteql.js";

// ═══════════════════════════════════════════════════════════
// POST /api/receive-po
//
// Creates an Item Receipt against a Purchase Order through the
// receivePurchaseOrder.js RESTlet. We go through a RESTlet (not the
// REST Record API's !transform/itemReceipt) because NS treats the
// receipt's inventoryDetail as a static sublist and rejects bin *names*
// for the binnumber field — see netsuite/receivePurchaseOrder.js.
//
// This endpoint's job:
//   1. Resolve scanned bin NAMES → internal ids (the RESTlet needs ids).
//   2. Sign an OAuth 1.0a request and forward to the RESTlet.
//
// Request body:
//   {
//     "purchaseOrderId": "123456",
//     "lines": [
//       { "itemId": "7566", "quantity": 10,
//         "bins": [ { "binNumber": "L-03-0009", "quantity": 7 },
//                   { "binNumber": "L-03-0010", "quantity": 3 } ] }
//     ]
//   }
//
// Response: { status:"created", receiptId, linesReceived, purchaseOrderId }
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const config = getConfig();
  if (!config.accountId || !config.consumerKey || !config.consumerSecret || !config.tokenId || !config.tokenSecret) {
    return res.status(500).json({
      error: "Missing NetSuite credentials. Set NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET in Vercel environment variables.",
    });
  }

  const restletUrl = process.env.NS_RESTLET_RECEIVE_PO_URL;
  if (!restletUrl) {
    return res.status(500).json({
      error: "NS_RESTLET_RECEIVE_PO_URL is not configured. See netsuite/README.md.",
    });
  }

  const { purchaseOrderId, lines } = req.body || {};
  if (!purchaseOrderId) return res.status(400).json({ error: "purchaseOrderId is required" });
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "lines[] must be a non-empty array" });
  }

  // ─── Resolve scanned bin names → internal ids ───
  const binNames = [...new Set(
    lines.flatMap(l => Array.isArray(l.bins) ? l.bins.map(b => String(b.binNumber || "").trim()) : [])
      .filter(Boolean)
  )];

  const binIdByName = {};
  if (binNames.length > 0) {
    const inList = binNames.map(n => `'${n.replace(/'/g, "''")}'`).join(",");
    try {
      const { items } = await runSuiteQL(`SELECT id, binnumber FROM Bin WHERE binnumber IN (${inList})`);
      for (const row of items) {
        // binnumber column is the bin's display name; id is the internal id.
        if (row.binnumber != null) binIdByName[String(row.binnumber)] = String(row.id);
      }
    } catch (e) {
      return res.status(502).json({ error: `Bin lookup failed: ${e.message}` });
    }
    const unresolved = binNames.filter(n => !binIdByName[n]);
    if (unresolved.length > 0) {
      return res.status(400).json({
        error: `Unknown bin(s): ${unresolved.join(", ")}. Check the bin exists at the receiving location.`,
      });
    }
  }

  // ─── Build RESTlet payload (bins keyed by internal id) ───
  const restletLines = lines
    .filter(l => l && l.itemId != null)
    .map(l => {
      const bins = (Array.isArray(l.bins) ? l.bins : [])
        .map(b => ({ binId: binIdByName[String(b.binNumber || "").trim()], quantity: Number(b.quantity) || 0 }))
        .filter(b => b.binId && b.quantity > 0);
      const line = { itemId: String(l.itemId), bins };
      if (l.quantity != null) line.quantity = Number(l.quantity) || 0;
      return line;
    });

  const restletBody = { purchaseOrderId: String(purchaseOrderId), lines: restletLines };

  // ─── Sign + forward to RESTlet ───
  const [base, qs] = restletUrl.split("?");
  const qp = {};
  if (qs) {
    for (const pair of qs.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) qp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }
  const authHeader = generateOAuthHeader("POST", base, qp, config);

  try {
    const nsResp = await fetch(restletUrl, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(restletBody),
    });
    const text = await nsResp.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }

    if (!nsResp.ok || !data?.receiptId) {
      console.error("RESTlet receive-po failed:", nsResp.status, text.slice(0, 800));
      console.error("RESTlet receive-po payload:", JSON.stringify(restletBody));
      return res.status(nsResp.status || 500).json({
        error: "Item Receipt create failed",
        details: data,
      });
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error("receive-po RESTlet threw:", e);
    return res.status(500).json({ error: `RESTlet call failed: ${e.message}` });
  }
}
