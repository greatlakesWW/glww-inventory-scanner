import { runSuiteQL } from "../_suiteql.js";
import { loadSOPerLocationRemaining } from "../_so-fulfillment.js";

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
//   Pending Fulfillment ('B') OR Partially Fulfilled ('D') so the
//   second location's plan still resolves the SO after the first
//   location ships. (See PRD H-1.)
//
// For Pending Fulfillment SOs the per-location aggregate comes from
// SuiteQL — every line is unfulfilled so summing tl.quantity gives
// the right answer. For Partially Fulfilled SOs, SuiteQL can't see
// quantityfulfilled in this account; we fall back to a REST Record
// API fetch (one per partial SO) to compute *remaining* qty per
// location and override the SuiteQL roll-up.
//
// Response:
//   {
//     resolved: [
//       {
//         id, tranId, shopifyOrderNumber, orderDate,
//         customerId, customerName, status,
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
        t.status AS status_id,
        BUILTIN.DF(t.entity) AS customer_name
      FROM transaction t
      WHERE t.type = 'SalesOrd'
        AND t.status IN ('B', 'D')
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

    // Group lines by SO id (raw SuiteQL aggregate — accurate for
    // status='B' SOs).
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

    // For Partially Fulfilled SOs the SuiteQL aggregate above counts
    // ordered qty, not remaining. Override per-location entries with
    // a REST-derived snapshot so the plan UI shows what's actually
    // left to pick. Done in parallel — typically only 1-2 partial SOs
    // per resolve call.
    const partials = hdrRows.filter((r) => String(r.status_id) === "D");
    if (partials.length > 0) {
      await Promise.all(partials.map(async (r) => {
        const sid = String(r.id);
        try {
          const remaining = await loadSOPerLocationRemaining(sid);
          // Replace this SO's perLocation list with the remaining-qty
          // version. Keep location names from the SuiteQL lookup.
          perLocBySo[sid] = Object.entries(remaining).map(([lid, agg]) => ({
            locationId: lid,
            locationName: locNameById[lid] || null,
            lineCount: agg.lineCount,
            totalQty: agg.totalQty,
          }));
          // Backfill any missing location names — REST may have
          // surfaced a location the SuiteQL aggregate query didn't.
          const missingLocIds = perLocBySo[sid]
            .filter((p) => p.locationId && !p.locationName)
            .map((p) => Number(p.locationId))
            .filter(Number.isInteger);
          if (missingLocIds.length > 0) {
            try {
              const { items: locs } = await runSuiteQL(
                `SELECT id, name FROM location WHERE id IN (${missingLocIds.join(",")})`,
              );
              const extraNames = {};
              for (const l of locs) extraNames[String(l.id)] = l.name;
              perLocBySo[sid] = perLocBySo[sid].map((p) =>
                p.locationName || !p.locationId ? p : { ...p, locationName: extraNames[p.locationId] || null }
              );
            } catch { /* non-fatal */ }
          }
        } catch (e) {
          console.warn(`resolve: REST fallback failed for SO ${sid}:`, e?.message);
          // Leave the SuiteQL aggregate in place — better to show stale
          // data than nothing. The detail endpoint will recompute when
          // the picker drills in.
        }
      }));
    }

    const resolved = hdrRows
      .map((r) => ({
        id: String(r.id),
        tranId: r.tran_id || null,
        shopifyOrderNumber: r.shopify_order_number != null ? String(r.shopify_order_number) : null,
        orderDate: r.tran_date || null,
        customerId: r.entity_id != null ? String(r.entity_id) : null,
        customerName: r.customer_name || null,
        status: r.status_id != null ? String(r.status_id) : null,
        perLocation: perLocBySo[String(r.id)] || [],
      }))
      // An SO whose every line at every location was just shipped by a
      // sibling location should not be returned as resolvable. The
      // tranid is "matched" but there's nothing to pick.
      .filter((o) => o.perLocation.length > 0);

    // SOs that the SuiteQL filter matched but have nothing pickable
    // left should fall back into the unresolved list so the picker
    // sees clear feedback.
    const droppedIds = new Set(
      hdrRows.map((r) => String(r.id)).filter((id) => (perLocBySo[id] || []).length === 0)
    );
    if (droppedIds.size > 0) {
      const droppedTrans = new Set(
        hdrRows
          .filter((r) => droppedIds.has(String(r.id)))
          .map((r) => String(r.tran_id || "").toUpperCase())
      );
      const droppedShopify = new Set(
        hdrRows
          .filter((r) => droppedIds.has(String(r.id)))
          .map((r) => r.shopify_order_number != null ? String(r.shopify_order_number) : null)
          .filter(Boolean)
      );
      for (const k of keys) {
        if (matchedShopify.has(k) && droppedShopify.has(k)) {
          if (!unresolved.includes(k)) unresolved.push(k);
        } else if (matchedTrans.has(k.toUpperCase()) && droppedTrans.has(k.toUpperCase())) {
          if (!unresolved.includes(k)) unresolved.push(k);
        }
      }
    }

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
