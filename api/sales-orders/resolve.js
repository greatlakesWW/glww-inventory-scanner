import { runSuiteQL } from "../_suiteql.js";

// ═══════════════════════════════════════════════════════════
// POST /api/sales-orders/resolve
//
// Given a list of identifiers, returns matching open Sales Orders
// with a per-location line breakdown — used by the multi-location
// plan UI where a picker scans Shopify packing slips and the app
// figures out where each order's stock lives.
//
// Body: { keys: ["25333", "SO111", "#25334"] }
//   Each key is tried against both custbody_fa_channel_order
//   (Shopify number) and tranid (NetSuite SO#). Status filter is
//   "Pending Fulfillment" only — same as the regular list path.
//
// Response:
//   {
//     resolved: [
//       {
//         id, tranId, shopifyOrderNumber, orderDate,
//         customerId, customerName,
//         perLocation: [
//           { locationId, locationName, lineCount, totalQty }
//         ]
//       }
//     ],
//     unresolved: ["25999"]
//   }
// ═══════════════════════════════════════════════════════════

const escLit = (v) => String(v).replace(/'/g, "''");
const normKey = (v) => String(v || "").trim().replace(/^#/, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = req.body || {};
  const rawKeys = Array.isArray(body.keys) ? body.keys : [];
  const keys = [...new Set(rawKeys.map(normKey).filter(Boolean))];
  if (keys.length === 0) {
    return res.status(400).json({ error: "Body must include a non-empty keys[] array" });
  }

  try {
    // Try each key against BOTH the Shopify custom field and tranid.
    // SuiteQL needs the literals quoted; escape single quotes too.
    const shopifyList = keys.map((k) => `'${escLit(k)}'`).join(",");
    const tranList = keys.map((k) => `'${escLit(k.toUpperCase())}'`).join(",");

    const headerQuery = `
      SELECT
        t.id AS id,
        t.tranid AS tran_id,
        t.trandate AS tran_date,
        t.custbody_fa_channel_order AS shopify_order_number,
        t.entity AS entity_id,
        BUILTIN.DF(t.entity) AS customer_name
      FROM transaction t
      WHERE t.type = 'SalesOrd'
        AND t.status = 'B'
        AND (
          t.custbody_fa_channel_order IN (${shopifyList})
          OR UPPER(t.tranid) IN (${tranList})
        )
    `;
    const { items: hdrRows } = await runSuiteQL(headerQuery);

    // Figure out which inputs didn't match anything.
    const matchedShopify = new Set(
      hdrRows.map((r) => r.shopify_order_number).filter(Boolean).map(String),
    );
    const matchedTrans = new Set(
      hdrRows.map((r) => String(r.tran_id || "").toUpperCase()),
    );
    const unresolved = [];
    for (const k of keys) {
      if (matchedShopify.has(k)) continue;
      if (matchedTrans.has(k.toUpperCase())) continue;
      unresolved.push(k);
    }

    if (hdrRows.length === 0) {
      return res.status(200).json({ resolved: [], unresolved });
    }

    // Per-SO + per-location aggregate of unfulfilled inventory lines.
    // Grouped query stays simple (no joins, no BUILTIN.DF) so the
    // SEARCH channel doesn't reject it.
    const idList = hdrRows.map((r) => Number(r.id)).filter(Number.isInteger);
    const linesQuery = `
      SELECT
        tl.transaction AS so_id,
        tl.location AS location_id,
        COUNT(tl.id) AS line_count,
        SUM(ABS(tl.quantity)) AS total_qty
      FROM transactionline tl
      WHERE tl.transaction IN (${idList.join(",")})
        AND tl.mainline = 'F'
        AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
        AND ABS(tl.quantity) > 0
      GROUP BY tl.transaction, tl.location
    `;
    const { items: lineRows } = await runSuiteQL(linesQuery);

    // Location names — separate lookup since BUILTIN.DF in a grouped
    // query is the kind of thing that breaks SEARCH.
    const locIds = [...new Set(
      lineRows.map((r) => Number(r.location_id)).filter(Number.isInteger)
    )];
    const locNameById = {};
    if (locIds.length > 0) {
      const { items: locs } = await runSuiteQL(
        `SELECT id, name FROM location WHERE id IN (${locIds.join(",")})`,
      );
      for (const l of locs) locNameById[String(l.id)] = l.name;
    }

    // Group lines by SO id.
    const perLocBySo = {};
    for (const l of lineRows) {
      const sid = String(l.so_id);
      if (!perLocBySo[sid]) perLocBySo[sid] = [];
      const lid = l.location_id != null ? String(l.location_id) : null;
      perLocBySo[sid].push({
        locationId: lid,
        locationName: lid ? locNameById[lid] || null : null,
        lineCount: Number(l.line_count) || 0,
        totalQty: Number(l.total_qty) || 0,
      });
    }

    const resolved = hdrRows.map((r) => ({
      id: String(r.id),
      tranId: r.tran_id || null,
      shopifyOrderNumber: r.shopify_order_number != null ? String(r.shopify_order_number) : null,
      orderDate: r.tran_date || null,
      customerId: r.entity_id != null ? String(r.entity_id) : null,
      customerName: r.customer_name || null,
      perLocation: perLocBySo[String(r.id)] || [],
    }));

    return res.status(200).json({ resolved, unresolved });
  } catch (err) {
    console.error("sales-orders/resolve error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message,
      ...(err.body ? { details: err.body } : {}),
    });
  }
}
