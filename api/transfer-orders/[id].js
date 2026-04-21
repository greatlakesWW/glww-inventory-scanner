import { runSuiteQL, batchIds } from "../_suiteql.js";

// ═══════════════════════════════════════════════════════════
// GET /api/transfer-orders/:id
//
// Returns TO header + lines + per-line bin availability at the
// source location. Powers the Pick Screen's initial data load.
//
// Source of truth: docs/FEATURE_SPEC_TO_FULFILLMENT.md §4.2
// ═══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // ─── CORS ───
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const rawId = req.query?.id;
  if (!rawId || typeof rawId !== "string") {
    return res.status(400).json({ error: "Missing sessionId path param" });
  }

  const toId = Number(rawId);
  if (!Number.isInteger(toId) || toId <= 0) {
    return res.status(400).json({ error: "':id' must be a positive integer" });
  }

  try {
    // ─── Step 1: header + eligible lines in a single query ───
    const linesQuery = `
      SELECT
        t.id AS internalid,
        t.tranid AS tran_id,
        t.location AS source_location_id,
        BUILTIN.DF(t.location) AS source_location_name,
        t.transferlocation AS destination_location_id,
        BUILTIN.DF(t.transferlocation) AS destination_location_name,
        tl.id AS line_id,
        tl.linesequencenumber AS line_number,
        tl.item AS item_id,
        item.itemid AS sku,
        item.displayname AS item_name,
        item.upccode AS upc,
        tl.quantity AS ordered_qty,
        tl.quantityfulfilled AS fulfilled_qty,
        (tl.quantity - COALESCE(tl.quantityfulfilled, 0)) AS remaining_qty
      FROM transaction t
      JOIN transactionline tl ON tl.transaction = t.id
      JOIN item ON tl.item = item.id
      WHERE t.id = ${toId}
        AND t.type = 'TrnfrOrd'
        AND tl.mainline = 'F'
        AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
      ORDER BY tl.linesequencenumber
    `;

    const { items: rows } = await runSuiteQL(linesQuery);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Transfer order not found" });
    }

    // Header comes from the first row (all rows share the same transaction).
    const header = rows[0];
    const sourceLocationId = Number(header.source_location_id);

    // ─── Step 2: per-bin availability for all line items at the source ───
    // Batch the IN (...) clause to stay under NetSuite's expression limits.
    const itemIds = [...new Set(rows.map((r) => Number(r.item_id)).filter((n) => Number.isInteger(n) && n > 0))];

    const binRows = [];
    if (itemIds.length > 0 && Number.isInteger(sourceLocationId) && sourceLocationId > 0) {
      for (const batch of batchIds(itemIds, 200)) {
        const binQuery = `
          SELECT
            ib.item AS item_id,
            ib.binnumber AS bin_id,
            BUILTIN.DF(ib.binnumber) AS bin_number,
            ib.quantityonhand AS qty_on_hand
          FROM inventorybalance ib
          WHERE ib.item IN (${batch.join(",")})
            AND ib.location = ${sourceLocationId}
            AND NVL(ib.quantityonhand, 0) > 0
          ORDER BY BUILTIN.DF(ib.binnumber) ASC
        `;
        const result = await runSuiteQL(binQuery);
        binRows.push(...result.items);
      }
    }

    // ─── Merge: group bins by item_id, attach to each line ───
    const binsByItem = {};
    for (const b of binRows) {
      const k = String(b.item_id);
      if (!binsByItem[k]) binsByItem[k] = [];
      binsByItem[k].push({
        binId: b.bin_id != null ? String(b.bin_id) : null,
        binNumber: b.bin_number,
        qtyOnHand: Number(b.qty_on_hand) || 0,
      });
    }

    // ─── Shape response per §4.2 ───
    const response = {
      id: String(header.internalid),
      tranId: header.tran_id,
      sourceLocationId: String(header.source_location_id),
      sourceLocationName: header.source_location_name,
      destinationLocationId: header.destination_location_id != null ? String(header.destination_location_id) : null,
      destinationLocationName: header.destination_location_name || null,
      lines: rows.map((r) => ({
        lineId: String(r.line_id),
        lineNumber: Number(r.line_number) || null,
        itemId: String(r.item_id),
        sku: r.sku,
        description: r.item_name,
        upc: r.upc || null,
        qtyOrdered: Number(r.ordered_qty) || 0,
        qtyAlreadyFulfilled: Number(r.fulfilled_qty) || 0,
        qtyRemaining: Number(r.remaining_qty) || 0,
        binAvailability: binsByItem[String(r.item_id)] || [],
      })),
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("transfer-orders/[id] GET error:", err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message,
      ...(err.body ? { details: err.body } : {}),
    });
  }
}
