import { runSuiteQL, batchIds, getSuiteQLConfig } from "../_suiteql.js";
import { generateOAuthHeader } from "../_auth.js";

// ═══════════════════════════════════════════════════════════
// GET /api/transfer-orders/:id
//
// Fetches TO header + lines via the NetSuite REST Record API
// (not SuiteQL). The SuiteQL SEARCH channel has classified the
// transactionline.quantityfulfilled field as NOT_EXPOSED, which
// blocks the natural list-oriented query. The Record API returns
// the same field as `quantityFulfilled` under a different
// exposure path.
//
// Per-line bin availability still comes from SuiteQL
// (inventorybalance.quantityonhand IS exposed).
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
    return res.status(400).json({ error: "Missing ':id' path parameter" });
  }
  const toId = Number(rawId);
  if (!Number.isInteger(toId) || toId <= 0) {
    return res.status(400).json({ error: "':id' must be a positive integer" });
  }

  try {
    // ─── Step 1: Fetch TO via REST Record API ───
    const config = getSuiteQLConfig(); // same 5-field credential check
    const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/transferOrder/${toId}`;
    const queryParams = { expandSubResources: "true" };
    const fullUrl = `${baseUrl}?expandSubResources=true`;
    const authHeader = generateOAuthHeader("GET", baseUrl, queryParams, config);

    const nsResp = await fetch(fullUrl, {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const nsText = await nsResp.text();
    let to = null;
    if (nsText) {
      try { to = JSON.parse(nsText); } catch { to = null; }
    }

    if (nsResp.status === 404) {
      return res.status(404).json({ error: "Transfer order not found" });
    }
    if (!nsResp.ok) {
      console.error(`transferOrder GET ${toId} failed:`, nsResp.status, nsText.slice(0, 800));
      return res.status(nsResp.status).json({
        error: `NetSuite returned ${nsResp.status}`,
        details: to || nsText,
      });
    }
    if (!to || typeof to !== "object") {
      return res.status(502).json({ error: "NetSuite returned unexpected response shape", details: nsText.slice(0, 500) });
    }

    // ─── Extract header + lines ───
    const sourceLocation = to.location || {};
    const destinationLocation = to.transferLocation || {};
    const sourceLocationId = sourceLocation.id != null ? Number(sourceLocation.id) : null;

    // With expandSubResources=true, sublists come back as { totalResults, items: [...] }
    // Defensive: support both `to.item.items` and `to.item` shapes, and skip non-inventory lines if a type is present.
    const rawLines = Array.isArray(to.item)
      ? to.item
      : Array.isArray(to.item?.items)
        ? to.item.items
        : [];

    // ─── Step 2: Enrich line items with SKU / UPC via SuiteQL item table ───
    // REST response gives item: { id, refName } — refName is the display name,
    // not the SKU. Pull sku/upc separately from the item table (which IS exposed to SuiteQL).
    const itemIds = [
      ...new Set(
        rawLines
          .map((l) => Number(l.item?.id))
          .filter((n) => Number.isInteger(n) && n > 0)
      ),
    ];

    const itemInfoById = {};
    if (itemIds.length > 0) {
      for (const batch of batchIds(itemIds, 200)) {
        const itemQuery = `
          SELECT
            item.id AS id,
            item.itemid AS sku,
            item.displayname AS display_name,
            item.upccode AS upc
          FROM item
          WHERE item.id IN (${batch.join(",")})
        `;
        const { items } = await runSuiteQL(itemQuery);
        for (const r of items) {
          itemInfoById[String(r.id)] = {
            sku: r.sku || null,
            displayName: r.display_name || null,
            upc: r.upc || null,
          };
        }
      }
    }

    // ─── Step 3: per-bin availability at source location ───
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
    const lines = rawLines.map((l) => {
      const itemId = l.item?.id != null ? String(l.item.id) : null;
      const info = itemId ? itemInfoById[itemId] : null;
      const qtyOrdered = Number(l.quantity) || 0;
      const qtyFulfilled = Number(l.quantityFulfilled) || 0;
      return {
        lineId: l.line != null ? String(l.line) : null,
        lineNumber: l.line != null ? Number(l.line) : null,
        itemId,
        sku: info?.sku || null,
        description: l.description || info?.displayName || l.item?.refName || null,
        upc: info?.upc || null,
        qtyOrdered,
        qtyAlreadyFulfilled: qtyFulfilled,
        qtyRemaining: Math.max(0, qtyOrdered - qtyFulfilled),
        binAvailability: itemId ? (binsByItem[itemId] || []) : [],
      };
    });

    // Extract status — REST Record returns either a string or { id, refName } object.
    const rawStatus = to.status;
    const statusId = typeof rawStatus === "string" ? rawStatus : rawStatus?.id || null;
    const statusName = typeof rawStatus === "string" ? rawStatus : rawStatus?.refName || null;

    const response = {
      id: String(to.id),
      tranId: to.tranId || null,
      statusId,
      status: statusName,
      sourceLocationId: sourceLocation.id != null ? String(sourceLocation.id) : null,
      sourceLocationName: sourceLocation.refName || null,
      destinationLocationId: destinationLocation.id != null ? String(destinationLocation.id) : null,
      destinationLocationName: destinationLocation.refName || null,
      lines,
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
