// ═══════════════════════════════════════════════════════════
// BIN LOOKUP — pure grouping helpers
//
// Kept free of React so the rules that actually matter (group
// ordering, the Uncategorized bucket, the auto-expand threshold)
// can be tested in the default node environment.
// ═══════════════════════════════════════════════════════════

export const UNCATEGORIZED = "Uncategorized";

// A bin with more SKUs than this renders with every class group
// collapsed — a Sales Floor catch-all bin becomes a short menu of
// classes instead of thousands of rows. At or below it, the bin
// reads as a plain list with no tapping.
export const AUTO_EXPAND_MAX_SKUS = 25;

/**
 * Group inventory rows by item class.
 * Returns [{ className, items, skuCount, unitCount }] sorted by class
 * name, with the Uncategorized group always last.
 */
export function groupByClass(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const raw = typeof row.class_name === "string" ? row.class_name.trim() : "";
    const className = raw || UNCATEGORIZED;
    if (!map.has(className)) {
      map.set(className, { className, items: [], skuCount: 0, unitCount: 0 });
    }
    const group = map.get(className);
    group.items.push(row);
    group.skuCount += 1;
    group.unitCount += Number(row.qty_on_hand) || 0;
  }

  return [...map.values()].sort((a, b) => {
    if (a.className === UNCATEGORIZED) return 1;
    if (b.className === UNCATEGORIZED) return -1;
    return a.className.localeCompare(b.className);
  });
}

/** Should every class group start expanded for a bin of this size? */
export function shouldAutoExpand(skuCount) {
  return skuCount <= AUTO_EXPAND_MAX_SKUS;
}
