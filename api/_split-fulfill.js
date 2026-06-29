import { runSuiteQL, batchIds } from "./_suiteql.js";

// ═══════════════════════════════════════════════════════════
// Cross-Location Fulfill — pure allocation logic.
//
// computeSplitPlan decides whether an order needs a cross-location
// split and, if so, how to spread each short line's remaining qty
// across the locations that actually hold the stock.
//
// "available" is NetSuite inventorybalance.quantityavailable.
// ═══════════════════════════════════════════════════════════

/**
 * @param {Array<{itemId:string, qtyRemaining:number, committedLocationId:string}>} lines
 * @param {Record<string, Array<{locationId:string, locationName?:string, available:number}>>} availByItem
 * @returns {{ needsSplit:boolean, splitLines:Array<{itemId:string, qtyRemaining:number, committedLocationId:string, allocations:Array<{locationId:string, locationName:string|null, qty:number}>}> }}
 */
export function computeSplitPlan(lines, availByItem) {
  const splitLines = [];
  let needsSplit = false;

  for (const line of lines) {
    const avail = (availByItem && availByItem[line.itemId]) || [];
    const need = Number(line.qtyRemaining) || 0;
    const committedAvail = avail
      .filter((a) => String(a.locationId) === String(line.committedLocationId))
      .reduce((s, a) => s + (Number(a.available) || 0), 0);
    const totalAvail = avail.reduce((s, a) => s + (Number(a.available) || 0), 0);

    // Sourceable as committed, or short everywhere (true stockout):
    // neither is a cross-location split candidate.
    if (committedAvail >= need || totalAvail < need) {
      splitLines.push({ ...line, allocations: [] });
      continue;
    }

    needsSplit = true;
    // Committed location first (consume what's already there), then
    // remaining locations most-available-first.
    const ordered = [...avail].sort((a, b) => {
      const ac = String(a.locationId) === String(line.committedLocationId);
      const bc = String(b.locationId) === String(line.committedLocationId);
      if (ac !== bc) return ac ? -1 : 1;
      return (Number(b.available) || 0) - (Number(a.available) || 0);
    });

    let remaining = need;
    const allocations = [];
    for (const a of ordered) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(a.available) || 0);
      if (take <= 0) continue;
      allocations.push({
        locationId: String(a.locationId),
        locationName: a.locationName || null,
        qty: take,
      });
      remaining -= take;
    }
    splitLines.push({ ...line, allocations });
  }

  return { needsSplit, splitLines };
}

// quantityavailable confirmed queryable in this account (probe 0.1).
export const AVAILABILITY_COLUMN = "quantityavailable";

export function shapeAvailabilityRows(rows) {
  const out = {};
  for (const r of rows || []) {
    const itemId = r.item_id != null ? String(r.item_id) : null;
    const locationId = r.location_id != null ? String(r.location_id) : null;
    if (!itemId || !locationId) continue;
    (out[itemId] ||= []).push({
      locationId,
      locationName: r.loc_name || null,
      available: Number(r.avail) || 0,
    });
  }
  return out;
}

/**
 * Loads per-(item, location) availability for the given item ids across
 * ALL locations. Returns availByItem suitable for computeSplitPlan.
 */
export async function loadAvailabilityByItem(itemIds) {
  const ids = [...new Set((itemIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return {};
  const col = AVAILABILITY_COLUMN;
  const all = [];
  for (const batch of batchIds(ids, 200)) {
    const { items } = await runSuiteQL(`
      SELECT
        ib.item AS item_id,
        ib.location AS location_id,
        BUILTIN.DF(ib.location) AS loc_name,
        SUM(ib.${col}) AS avail
      FROM inventorybalance ib
      WHERE ib.item IN (${batch.join(",")})
        AND NVL(ib.${col}, 0) > 0
      GROUP BY ib.item, ib.location, BUILTIN.DF(ib.location)
    `);
    all.push(...items);
  }
  return shapeAvailabilityRows(all);
}
