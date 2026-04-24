import { runSuiteQL } from "./_suiteql.js";
import { kv } from "@vercel/kv";
import { KEY_SO_LOCK } from "./_kv.js";

// ═══════════════════════════════════════════════════════════
// GET /api/sales-orders?location={id}
//
// Lists Sales Orders in "Pending Fulfillment" status that have at
// least one unfulfilled inventory line at the requested location.
// Uses SuiteQL — unlike transferorder, the SO record type exposes
// `transactionline.quantityfulfilled` and `transactionline.location`
// to SuiteQL's SEARCH channel in this account.
//
// Each SO returned is decorated with lockedBy/lockedAt if a wave
// session currently holds it (so the UI can show "Bryce is picking").
// ═══════════════════════════════════════════════════════════

function escLit(v) {
  return String(v).replace(/'/g, "''");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const location = req.query?.location;
  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "Missing 'location' query parameter" });
  }
  const locationId = Number(location);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: "'location' must be a positive integer" });
  }

  try {
    // Two-query approach — SuiteQL's SEARCH channel rejects the
    // combination of GROUP BY, aggregate functions (SUM/COUNT), and
    // BUILTIN.DF() in this account with "Invalid or unsupported
    // search". Splitting keeps each query on a happy path:
    //   1. DISTINCT header list — one row per qualifying SO.
    //   2. Aggregate line rollup for those SO ids — line_count + qty.
    //
    // Pending Fulfillment (t.status='B') guarantees qty_fulfilled=0,
    // so we don't need quantityfulfilled (which is NOT_EXPOSED to
    // SuiteQL anyway). SO quantity is stored negative — ABS() it.
    const headerQuery = `
      SELECT DISTINCT
        t.id AS id,
        t.tranid AS tran_id,
        t.trandate AS tran_date,
        t.entity AS entity_id,
        BUILTIN.DF(t.entity) AS customer_name
      FROM transaction t
      INNER JOIN transactionline tl ON tl.transaction = t.id
      WHERE t.type = 'SalesOrd'
        AND t.status = 'B'
        AND tl.mainline = 'F'
        AND tl.location = ${locationId}
        AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
        AND ABS(tl.quantity) > 0
      ORDER BY t.trandate DESC, t.id DESC
    `;
    const { items } = await runSuiteQL(headerQuery);

    // Per-SO rollup so list rows can show a line/qty summary. Uses a
    // plain GROUP BY over transactionline (no joins, no BUILTIN.DF),
    // which the SEARCH channel accepts.
    const aggBySoId = {};
    if (items.length > 0) {
      const idList = items.map((r) => Number(r.id)).filter(Number.isFinite);
      if (idList.length > 0) {
        const aggQuery = `
          SELECT
            tl.transaction AS so_id,
            COUNT(tl.id) AS line_count,
            SUM(ABS(tl.quantity)) AS total_qty
          FROM transactionline tl
          WHERE tl.transaction IN (${idList.join(",")})
            AND tl.mainline = 'F'
            AND tl.location = ${locationId}
            AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
            AND ABS(tl.quantity) > 0
          GROUP BY tl.transaction
        `;
        try {
          const { items: aggRows } = await runSuiteQL(aggQuery);
          for (const a of aggRows) {
            aggBySoId[String(a.so_id)] = {
              lineCount: Number(a.line_count) || 0,
              remainingQty: Number(a.total_qty) || 0,
            };
          }
        } catch (e) {
          // Non-fatal: list still works without the rollup; the UI
          // can omit counts and fall back to detail fetches.
          console.warn("sales-orders aggregate query failed:", e.message);
        }
      }
    }

    const orders = items.map((r) => {
      const agg = aggBySoId[String(r.id)] || {};
      return {
        id: String(r.id),
        tranId: r.tran_id || null,
        orderDate: r.tran_date || null,
        customerId: r.entity_id != null ? String(r.entity_id) : null,
        customerName: r.customer_name || null,
        remainingQty: agg.remainingQty != null ? agg.remainingQty : null,
        lineCount: agg.lineCount != null ? agg.lineCount : null,
        lockedBy: null,
        lockedAt: null,
        lockedSessionId: null,
      };
    });

    if (orders.length > 0) {
      const lockKeys = orders.map((o) => KEY_SO_LOCK(o.id));
      const lockSessionIds = await Promise.all(lockKeys.map((k) => kv.get(k)));
      // Fetch each owning wave session once to get pickerName + updatedAt.
      const uniqueSessionIds = [...new Set(lockSessionIds.filter(Boolean))];
      const sessions = await Promise.all(
        uniqueSessionIds.map((id) => kv.get(`session:wave:${id}`))
      );
      const bySessionId = {};
      uniqueSessionIds.forEach((id, i) => { bySessionId[id] = sessions[i]; });

      orders.forEach((o, i) => {
        const sid = lockSessionIds[i];
        const s = sid ? bySessionId[sid] : null;
        if (s) {
          o.lockedBy = s.pickerName || null;
          o.lockedAt = s.updatedAt || null;
          o.lockedSessionId = sid;
        }
      });
    }

    return res.status(200).json({ orders });
  } catch (err) {
    console.error("sales-orders GET error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message,
      ...(err.body ? { details: err.body } : {}),
    });
  }
}
