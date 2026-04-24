import { runSuiteQL, batchIds } from "../_suiteql.js";

// ═══════════════════════════════════════════════════════════
// GET /api/sales-orders/:id?location={id}
//
// Fetches SO header, unfulfilled inventory lines at the requested
// source location, and per-line bin availability at that location.
//
// location is required because an SO can have lines at multiple
// locations; a picker only cares about the ones they can physically
// grab from where they're standing.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const rawId = req.query?.id;
  if (!rawId || typeof rawId !== "string") {
    return res.status(400).json({ error: "Missing ':id' path parameter" });
  }
  const soId = Number(rawId);
  if (!Number.isInteger(soId) || soId <= 0) {
    return res.status(400).json({ error: "':id' must be a positive integer" });
  }

  const rawLoc = req.query?.location;
  const locationId = rawLoc != null ? Number(rawLoc) : NaN;
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: "'location' query parameter is required" });
  }

  try {
    // ─── Header ───
    const headerRows = await runSuiteQL(`
      SELECT
        t.id AS id,
        t.tranid AS tran_id,
        t.trandate AS tran_date,
        BUILTIN.DF(t.entity) AS customer_name,
        BUILTIN.DF(t.status) AS status_name,
        t.status AS status_id
      FROM transaction t
      WHERE t.id = ${soId}
        AND t.type = 'SalesOrd'
    `);
    if (headerRows.items.length === 0) {
      return res.status(404).json({ error: "Sales order not found" });
    }
    const hdr = headerRows.items[0];

    // SuiteQL's SEARCH channel doesn't expose transactionline.quantityfulfilled
    // in this account (same constraint as api/transfer-orders/[id].js hit).
    // We only list Pending Fulfillment SOs, where every line is
    // unfulfilled, so qty_remaining == qty_ordered here. If support for
    // Partially Fulfilled SOs is added later, swap this query for a
    // REST Record API fetch so quantityFulfilled becomes available.
    //
    // SO transactionline.quantity is stored NEGATIVE; ABS() for display.
    const lineRows = await runSuiteQL(`
      SELECT
        tl.id AS line_id,
        tl.linesequencenumber AS line_number,
        tl.item AS item_id,
        item.itemid AS sku,
        item.displayname AS display_name,
        item.upccode AS upc,
        ABS(tl.quantity) AS qty_ordered
      FROM transactionline tl
      JOIN item ON item.id = tl.item
      WHERE tl.transaction = ${soId}
        AND tl.mainline = 'F'
        AND tl.location = ${locationId}
        AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
        AND ABS(tl.quantity) > 0
      ORDER BY tl.linesequencenumber ASC
    `);

    const lines = lineRows.items;

    // ─── Bin availability per item at this location ───
    const itemIds = [...new Set(lines.map((l) => Number(l.item_id)).filter((n) => Number.isInteger(n)))];
    const binsByItem = {};
    if (itemIds.length > 0) {
      for (const batch of batchIds(itemIds, 200)) {
        const binQ = `
          SELECT
            ib.item AS item_id,
            ib.binnumber AS bin_id,
            BUILTIN.DF(ib.binnumber) AS bin_number,
            ib.quantityonhand AS qty_on_hand
          FROM inventorybalance ib
          WHERE ib.item IN (${batch.join(",")})
            AND ib.location = ${locationId}
            AND NVL(ib.quantityonhand, 0) > 0
          ORDER BY BUILTIN.DF(ib.binnumber) ASC
        `;
        const { items: rows } = await runSuiteQL(binQ);
        for (const b of rows) {
          const k = String(b.item_id);
          if (!binsByItem[k]) binsByItem[k] = [];
          binsByItem[k].push({
            binId: b.bin_id != null ? String(b.bin_id) : null,
            binNumber: b.bin_number,
            qtyOnHand: Number(b.qty_on_hand) || 0,
          });
        }
      }
    }

    const shapedLines = lines.map((l) => {
      const itemId = l.item_id != null ? String(l.item_id) : null;
      const qtyOrdered = Number(l.qty_ordered) || 0;
      return {
        lineId: l.line_id != null ? String(l.line_id) : null,
        lineNumber: l.line_number != null ? Number(l.line_number) : null,
        itemId,
        sku: l.sku || null,
        description: l.display_name || null,
        upc: l.upc || null,
        qtyOrdered,
        qtyAlreadyFulfilled: 0,
        qtyRemaining: qtyOrdered,
        binAvailability: itemId ? (binsByItem[itemId] || []) : [],
      };
    });

    return res.status(200).json({
      id: String(hdr.id),
      tranId: hdr.tran_id || null,
      orderDate: hdr.tran_date || null,
      customerName: hdr.customer_name || null,
      status: hdr.status_name || hdr.status_id || null,
      sourceLocationId: String(locationId),
      lines: shapedLines,
    });
  } catch (err) {
    console.error("sales-orders/[id] GET error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message,
      ...(err.body ? { details: err.body } : {}),
    });
  }
}
