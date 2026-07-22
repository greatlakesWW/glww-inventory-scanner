import { runSuiteQL } from "./_suiteql.js";

// ═══════════════════════════════════════════════════════════
// Location-scoped bin resolution.
//
// Used by GET /api/bins/validate (live modal validation) and by
// POST /api/transfer-orders/:id/fulfill (server-side re-validation
// before any NetSuite write). The location filter matters: bin
// numbers are only unique per location, so a global match could
// return a same-named bin at the wrong warehouse.
// ═══════════════════════════════════════════════════════════

export function buildBinLookupQuery(binNumber, locationId) {
  const escaped = String(binNumber).replace(/'/g, "''");
  return (
    `SELECT id, binnumber FROM Bin ` +
    `WHERE UPPER(binnumber) = UPPER('${escaped}') ` +
    `AND location = ${Number(locationId)} ` +
    `AND isinactive = 'F' ` +
    `FETCH FIRST 1 ROWS ONLY`
  );
}

/**
 * Resolve a bin number to its internal ID, scoped to a location.
 * Returns { binId, binNumber } (canonical NetSuite casing) or null.
 * `queryRunner` is injectable for tests; defaults to runSuiteQL.
 */
export async function resolveBinAtLocation(binNumber, locationId, queryRunner = runSuiteQL) {
  const name = typeof binNumber === "string" ? binNumber.trim() : "";
  const loc = Number(locationId);
  if (!name || !Number.isInteger(loc) || loc <= 0) return null;
  const { items } = await queryRunner(buildBinLookupQuery(name, loc));
  const row = Array.isArray(items) ? items[0] : null;
  if (!row || row.id == null) return null;
  return { binId: String(row.id), binNumber: row.binnumber || name };
}
