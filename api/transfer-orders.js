import { kv } from "@vercel/kv";
import { runSuiteQL, batchIds } from "./_suiteql.js";
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
    // ─── Query 1: TO headers only ───
    // Filtering on transactionline fields like `quantityfulfilled` across
    // arbitrary transactions is blocked by NetSuite's SEARCH-channel field
    // exposure rules (NOT_EXPOSED). Detail queries with a specific
    // transaction ID work; broad aggregate scans do not. So we pull headers
    // first, then aggregate line counts in a second query scoped to the
    // returned transaction IDs.
    const headerQuery = `
      SELECT
        t.id AS internalid,
        t.tranid AS tran_id,
        t.trandate AS order_date,
        t.location AS source_location_id,
        BUILTIN.DF(t.location) AS source_location_name,
        t.transferlocation AS destination_location_id,
        BUILTIN.DF(t.transferlocation) AS destination_location_name,
        BUILTIN.DF(t.status) AS status_name,
        t.status AS status_code
      FROM transaction t
      WHERE t.type = 'TrnfrOrd'
        AND t.location = ${locationId}
        AND t.status IN ('TrnfrOrd:B', 'TrnfrOrd:D')
      ORDER BY t.trandate DESC
    `;

    const { items: headers } = await runSuiteQL(headerQuery);

    // ─── Query 2: aggregate line counts, scoped by transaction ID ───
    // Mirror the working production pattern (TransferOrders.jsx uses
    // `WHERE tl.transaction = {single_id}` successfully). The IN clause
    // scopes this to specific TOs rather than an open-ended scan.
    // Wrapped in try/catch: if aggregation still trips exposure rules,
    // degrade gracefully to null counts rather than failing the list.
    const aggsByTo = {};
    if (headers.length > 0) {
      const toIds = headers
        .map((h) => Number(h.internalid))
        .filter((n) => Number.isInteger(n) && n > 0);
      try {
        for (const batch of batchIds(toIds, 200)) {
          const aggQuery = `
            SELECT
              tl.transaction AS to_id,
              COUNT(tl.id) AS line_count,
              SUM(tl.quantity - COALESCE(tl.quantityfulfilled, 0)) AS total_remaining_qty
            FROM transactionline tl
            WHERE tl.transaction IN (${batch.join(",")})
              AND tl.mainline = 'F'
              AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
              AND (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) > 0
            GROUP BY tl.transaction
          `;
          const { items } = await runSuiteQL(aggQuery);
          for (const row of items) {
            aggsByTo[String(row.to_id)] = {
              lineCount: Number(row.line_count) || 0,
              totalQty: Number(row.total_remaining_qty) || 0,
            };
          }
        }
      } catch (aggErr) {
        console.warn("transfer-orders: line aggregation failed, returning null counts:", aggErr.message);
      }
    }

    // ─── Lock-state merge (KV) ───
    // For each TO, look up session:to:{toId} in KV. Cheaper than SCAN for
    // small result sets and exact-match semantics.
    const sessions = await Promise.all(
      headers.map((row) => kv.get(KEY_SESSION_BY_TO(String(row.internalid))))
    );

    // ─── Shape response per §4.1 ───
    const orders = headers.map((row, i) => {
      const sess = sessions[i];
      const agg = aggsByTo[String(row.internalid)];
      return {
        id: String(row.internalid),
        tranId: row.tran_id,
        orderDate: row.order_date,
        sourceLocationId: String(row.source_location_id),
        sourceLocationName: row.source_location_name,
        destinationLocationId: row.destination_location_id != null ? String(row.destination_location_id) : null,
        destinationLocationName: row.destination_location_name || null,
        status: row.status_name,
        lineCount: agg ? agg.lineCount : null,
        totalQty: agg ? agg.totalQty : null,
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
