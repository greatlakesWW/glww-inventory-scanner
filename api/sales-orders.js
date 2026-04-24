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
    // We filter on t.status = 'SalesOrd:B' (Pending Fulfillment). Every
    // line on a Pending SO is unfulfilled by definition, so there's no
    // need to compute (quantity - quantityfulfilled) — and we couldn't
    // anyway, because transactionline.quantityfulfilled is NOT_EXPOSED
    // to SuiteQL's SEARCH channel in this account. If we ever need to
    // list Partially Fulfilled SOs too, that's the point to pivot to
    // the REST Record API, same as api/transfer-orders/[id].js does.
    const query = `
      SELECT
        t.id AS id,
        t.tranid AS tran_id,
        t.trandate AS tran_date,
        t.entity AS entity_id,
        BUILTIN.DF(t.entity) AS customer_name,
        SUM(tl.quantity) AS remaining_qty,
        COUNT(tl.id) AS line_count
      FROM transaction t
      INNER JOIN transactionline tl ON tl.transaction = t.id
      WHERE t.type = 'SalesOrd'
        AND t.status = 'B'
        AND tl.mainline = 'F'
        AND tl.location = ${locationId}
        AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
        AND tl.quantity > 0
      GROUP BY t.id, t.tranid, t.trandate, t.entity
      ORDER BY t.trandate ASC, t.id ASC
    `;

    const { items } = await runSuiteQL(query);

    const orders = items.map((r) => ({
      id: String(r.id),
      tranId: r.tran_id || null,
      orderDate: r.tran_date || null,
      customerId: r.entity_id != null ? String(r.entity_id) : null,
      customerName: r.customer_name || null,
      remainingQty: Number(r.remaining_qty) || 0,
      lineCount: Number(r.line_count) || 0,
      lockedBy: null,
      lockedAt: null,
      lockedSessionId: null,
    }));

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
