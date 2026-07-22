import { resolveBinAtLocation } from "../_bins.js";
import { getSuiteQLConfig } from "../_suiteql.js";

// ═══════════════════════════════════════════════════════════
// GET /api/bins/validate?locationId=X&binNumber=Y
//
// Live validation for the Complete Pick modal's destination-bin
// field. Purely advisory for UX — the fulfill endpoint re-validates
// server-side before writing anything to NetSuite.
//
// Caller contract: call on Enter/blur (per scan), NOT on every
// onChange keystroke — each call consumes NetSuite's account-wide
// concurrency budget.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const locationId = Number(req.query?.locationId);
  const binNumber =
    typeof req.query?.binNumber === "string" ? req.query.binNumber.trim() : "";

  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: "'locationId' must be a positive integer" });
  }
  if (!binNumber) {
    return res.status(400).json({ error: "'binNumber' is required" });
  }

  try {
    getSuiteQLConfig(); // throws 500 with a helpful message if creds missing
    const bin = await resolveBinAtLocation(binNumber, locationId);
    if (!bin) return res.status(200).json({ valid: false });
    return res.status(200).json({ valid: true, binId: bin.binId, binNumber: bin.binNumber });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
