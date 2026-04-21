import { kv } from "@vercel/kv";
import { runSuiteQL } from "./_suiteql.js";
import { KEY_SESSION_BY_TO } from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// GET /api/transfer-orders?location={id}
//
// Returns open Transfer Orders at the given source location.
// Merges in live lock state from Vercel KV so the client can
// render "In Progress by [name]" without a second round trip.
//
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.1
// ═══════════════════════════════════════════════════════════
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

  // Coerce to integer to avoid SuiteQL injection surface. Location IDs are
  // always numeric internal IDs; reject anything else early.
  const locationId = Number(location);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: "'location' must be a positive integer" });
  }

  try {
    // ─── SuiteQL ───
    // Single query: join transaction + transactionline, aggregate line count
    // and remaining qty per TO. Filter to open outbound TOs only
    // (TrnfrOrd:B = Pending Fulfillment, TrnfrOrd:D = Partially Fulfilled).
    const query = `
      SELECT
        t.id AS internalid,
        t.tranid AS tran_id,
        t.trandate AS order_date,
        t.location AS source_location_id,
        BUILTIN.DF(t.location) AS source_location_name,
        t.transferlocation AS destination_location_id,
        BUILTIN.DF(t.transferlocation) AS destination_location_name,
        BUILTIN.DF(t.status) AS status_name,
        t.status AS status_code,
        COUNT(tl.id) AS line_count,
        SUM(tl.quantity - COALESCE(tl.quantityfulfilled, 0)) AS total_remaining_qty
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      WHERE t.type = 'TrnfrOrd'
        AND t.location = ${locationId}
        AND t.status IN ('TrnfrOrd:B', 'TrnfrOrd:D')
        AND tl.mainline = 'F'
        AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
        AND (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) > 0
      GROUP BY t.id, t.tranid, t.trandate, t.location, BUILTIN.DF(t.location),
        t.transferlocation, BUILTIN.DF(t.transferlocation), BUILTIN.DF(t.status), t.status
      ORDER BY t.trandate DESC
    `;

    const { items } = await runSuiteQL(query);

    // ─── Lock-state merge (KV) ───
    // For each TO, look up session:to:{toId} in KV. Cheaper than SCAN for small
    // result sets and exact-match semantics.
    const sessions = await Promise.all(
      items.map((row) => kv.get(KEY_SESSION_BY_TO(String(row.internalid))))
    );

    // ─── Shape response per §4.1 ───
    const orders = items.map((row, i) => {
      const sess = sessions[i];
      return {
        id: String(row.internalid),
        tranId: row.tran_id,
        orderDate: row.order_date,
        sourceLocationId: String(row.source_location_id),
        sourceLocationName: row.source_location_name,
        destinationLocationId: row.destination_location_id != null ? String(row.destination_location_id) : null,
        destinationLocationName: row.destination_location_name || null,
        status: row.status_name,
        lineCount: Number(row.line_count) || 0,
        totalQty: Number(row.total_remaining_qty) || 0,
        lockedBy: sess?.pickerName || null,
        lockedAt: sess?.updatedAt || null,
      };
    });

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
