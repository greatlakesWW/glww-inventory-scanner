import { runSuiteQL, getSuiteQLConfig } from "./_suiteql.js";
import { generateOAuthHeader } from "./_auth.js";

// ═══════════════════════════════════════════════════════════
// Shared helpers for SO line-level fulfillment state
//
// SuiteQL's SEARCH channel doesn't expose
// `transactionline.quantityfulfilled` in this account, so the bare
// SuiteQL path can only correctly answer "what's unfulfilled?" for
// Pending Fulfillment SOs (status='B') where every line is by
// definition fully unfulfilled.
//
// Once a Partially Fulfilled SO (status='D') is in play — which
// happens the moment a sibling location ships an IF — we need a
// surgical REST Record API fetch to read `quantityFulfilled` per
// line. This module centralises that two-path logic so the detail
// endpoint and the wave-creation H-3 validator agree.
// ═══════════════════════════════════════════════════════════

const STATUS_PENDING = "B";          // Pending Fulfillment
const STATUS_PARTIAL = "D";          // Partially Fulfilled
export const PICKABLE_SO_STATUSES = new Set([STATUS_PENDING, STATUS_PARTIAL]);

/**
 * Loads all unfulfilled inventory lines at a given location for an SO.
 * Returns null if the SO doesn't exist or isn't in a pickable status.
 *
 * @param {number|string} soId
 * @param {number|string} locationId
 * @returns {Promise<null | {
 *   id: string, tranId: string|null, orderDate: string|null,
 *   customerName: string|null, statusId: string, statusName: string|null,
 *   lines: Array<{
 *     lineId: string|null, lineNumber: number|null, itemId: string,
 *     sku: string|null, description: string|null, upc: string|null,
 *     qtyOrdered: number, qtyAlreadyFulfilled: number, qtyRemaining: number
 *   }>
 * }>}
 */
export async function loadSORemainingAtLocation(soId, locationId) {
  const soIdNum = Number(soId);
  const locIdNum = Number(locationId);
  if (!Number.isInteger(soIdNum) || soIdNum <= 0) throw new Error("soId must be a positive integer");
  if (!Number.isInteger(locIdNum) || locIdNum <= 0) throw new Error("locationId must be a positive integer");

  // ─── Header ───
  const { items: hdrRows } = await runSuiteQL(`
    SELECT
      t.id AS id,
      t.tranid AS tran_id,
      t.trandate AS tran_date,
      BUILTIN.DF(t.entity) AS customer_name,
      BUILTIN.DF(t.status) AS status_name,
      t.status AS status_id
    FROM transaction t
    WHERE t.id = ${soIdNum}
      AND t.type = 'SalesOrd'
  `);
  if (hdrRows.length === 0) return null;
  const hdr = hdrRows[0];
  const statusId = String(hdr.status_id || "");

  // ─── Lines at this location ───
  // SO transactionline.quantity is stored NEGATIVE; ABS() for display.
  const { items: lineRows } = await runSuiteQL(`
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
    WHERE tl.transaction = ${soIdNum}
      AND tl.mainline = 'F'
      AND tl.location = ${locIdNum}
      AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
      AND ABS(tl.quantity) > 0
    ORDER BY tl.linesequencenumber ASC
  `);

  // ─── Per-line qtyAlreadyFulfilled ───
  // Pending Fulfillment: every line unfulfilled, no REST call needed.
  // Partially Fulfilled: SuiteQL doesn't expose quantityfulfilled in
  //   this account's SEARCH channel, so we fall through to a REST
  //   Record API fetch and key by line number.
  // Other statuses (Closed, Pending Approval, etc.): not pickable;
  //   return an empty lines list so callers can short-circuit.
  if (!PICKABLE_SO_STATUSES.has(statusId)) {
    return shapeResult(hdr, statusId, []);
  }

  let fulfilledByLineNumber = null;
  if (statusId === STATUS_PARTIAL && lineRows.length > 0) {
    fulfilledByLineNumber = await fetchFulfilledMapREST(soIdNum, locIdNum);
  }

  const shaped = lineRows.map((l) => {
    const qtyOrdered = Number(l.qty_ordered) || 0;
    const lineNumber = l.line_number != null ? Number(l.line_number) : null;
    const qtyAlreadyFulfilled = fulfilledByLineNumber && lineNumber != null
      ? (fulfilledByLineNumber[String(lineNumber)] || 0)
      : 0;
    const qtyRemaining = Math.max(0, qtyOrdered - qtyAlreadyFulfilled);
    return {
      lineId: l.line_id != null ? String(l.line_id) : null,
      lineNumber,
      itemId: l.item_id != null ? String(l.item_id) : null,
      sku: l.sku || null,
      description: l.display_name || null,
      upc: l.upc || null,
      qtyOrdered,
      qtyAlreadyFulfilled,
      qtyRemaining,
    };
  }).filter((l) => l.qtyRemaining > 0);

  return shapeResult(hdr, statusId, shaped);
}

function shapeResult(hdr, statusId, lines) {
  return {
    id: String(hdr.id),
    tranId: hdr.tran_id || null,
    orderDate: hdr.tran_date || null,
    customerName: hdr.customer_name || null,
    statusId,
    statusName: hdr.status_name || null,
    lines,
  };
}

/**
 * REST Record API fallback for Partially Fulfilled SOs.
 * Returns a map keyed by line number → quantityFulfilled at the given
 * location. Only lines at the requested location are included.
 */
async function fetchFulfilledMapREST(soId, locationId) {
  const items = await fetchSOItemSublistREST(soId);
  const map = {};
  for (const row of items) {
    const lineLocId = row?.location?.id != null ? Number(row.location.id) : null;
    if (lineLocId !== Number(locationId)) continue;
    // `line` is the line sequence number (1-based) on the sublist —
    // matches transactionline.linesequencenumber.
    const lineNumber = row?.line != null ? Number(row.line) : null;
    if (lineNumber == null) continue;
    const fulfilled = Number(row?.quantityFulfilled || 0) || 0;
    map[String(lineNumber)] = fulfilled;
  }
  return map;
}

/**
 * For a Partially Fulfilled SO, returns per-location aggregates of
 * UNFULFILLED inventory lines. Used by /resolve so the location cards
 * only show the work that's actually still pickable at each warehouse.
 *
 * @param {number|string} soId
 * @returns {Promise<Record<string, { lineCount: number, totalQty: number }>>}
 */
export async function loadSOPerLocationRemaining(soId) {
  const items = await fetchSOItemSublistREST(soId);
  const agg = {};
  for (const row of items) {
    const itemType = row?.item?.refName || row?.itemType || null;
    // The expanded SO sublist includes non-inventory items (descriptions,
    // discounts, shipping). Only inventory-style rows have a location +
    // a meaningful quantityFulfilled vs quantity comparison. Filter by
    // presence of a location id — non-inventory rows lack one.
    const locId = row?.location?.id != null ? String(row.location.id) : null;
    if (!locId) continue;
    const ordered = Math.abs(Number(row?.quantity || 0));
    const fulfilled = Number(row?.quantityFulfilled || 0) || 0;
    const remaining = Math.max(0, ordered - fulfilled);
    if (remaining <= 0) continue;
    if (!agg[locId]) agg[locId] = { lineCount: 0, totalQty: 0 };
    agg[locId].lineCount += 1;
    agg[locId].totalQty += remaining;
  }
  return agg;
}

async function fetchSOItemSublistREST(soId) {
  const config = getSuiteQLConfig();
  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder/${soId}`;
  const queryParams = { expandSubResources: "true" };
  const fullUrl = `${baseUrl}?expandSubResources=true`;
  const auth = generateOAuthHeader("GET", baseUrl, queryParams, config);

  const resp = await fetch(fullUrl, {
    method: "GET",
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) {
    const detail = typeof data === "object" && data !== null ? JSON.stringify(data) : String(data || "");
    const err = new Error(`SO REST fetch ${resp.status}: ${detail.slice(0, 300)}`);
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return (data && data.item && Array.isArray(data.item.items)) ? data.item.items : [];
}
