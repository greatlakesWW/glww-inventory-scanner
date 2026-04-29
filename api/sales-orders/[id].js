import { runSuiteQL, batchIds } from "../_suiteql.js";
import { loadSORemainingAtLocation } from "../_so-fulfillment.js";

// ═══════════════════════════════════════════════════════════
// GET /api/sales-orders/:id?location={id}
//
// Fetches SO header, unfulfilled inventory lines at the requested
// source location, and per-line bin availability at that location.
//
// location is required because an SO can have lines at multiple
// locations; a picker only cares about the ones they can physically
// grab from where they're standing.
//
// For Pending Fulfillment SOs the line set comes straight from
// SuiteQL (every line is unfulfilled). For Partially Fulfilled SOs
// — which happen the moment a sibling location ships an IF — the
// shared helper falls back to a REST Record API fetch to read
// quantityFulfilled per line and computes the actual remaining qty.
// See PRD H-1.
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
    const so = await loadSORemainingAtLocation(soId, locationId);
    if (!so) return res.status(404).json({ error: "Sales order not found" });

    // ─── Bin availability per item at this location ───
    const itemIds = [...new Set(
      so.lines.map((l) => Number(l.itemId)).filter((n) => Number.isInteger(n))
    )];
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

    const shapedLines = so.lines.map((l) => ({
      lineId: l.lineId,
      lineNumber: l.lineNumber,
      itemId: l.itemId,
      sku: l.sku,
      description: l.description,
      upc: l.upc,
      qtyOrdered: l.qtyOrdered,
      qtyAlreadyFulfilled: l.qtyAlreadyFulfilled,
      qtyRemaining: l.qtyRemaining,
      binAvailability: l.itemId ? (binsByItem[l.itemId] || []) : [],
    }));

    return res.status(200).json({
      id: so.id,
      tranId: so.tranId,
      orderDate: so.orderDate,
      customerName: so.customerName,
      status: so.statusName || so.statusId,
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
