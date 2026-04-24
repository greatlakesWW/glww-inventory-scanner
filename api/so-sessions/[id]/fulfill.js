import { kv } from "@vercel/kv";
import { getSuiteQLConfig, runSuiteQL } from "../../_suiteql.js";
import { generateOAuthHeader } from "../../_auth.js";
import {
  getWaveSession,
  writeWaveSession,
  deleteWaveSession,
} from "../../_kv.js";

// ═══════════════════════════════════════════════════════════
// POST /api/so-sessions/:id/fulfill
//
// Completes a wave pick session:
//   1. Load the wave (soIds + scan events)
//   2. Build a FIFO scan queue per itemId from the scan event log
//   3. Walk SOs oldest-first. For each SO, pull its unfulfilled lines
//      at the wave's source location and allocate from the pool.
//   4. For each SO with a non-empty allocation, call the RESTlet
//      fulfillSalesOrder RESTlet. setShipped=true only if the allocation
//      covered every remaining line at this location.
//   5. On any success, delete the wave session (releases SO locks).
//      Per-SO results are returned so the client can show the
//      picker which SOs went fully vs partially fulfilled.
//
// Shortages surface both at the SO level (one IF per SO) and at the
// wave level (a `shortages` array in the response).
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const sessionId = req.query?.id;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing sessionId path param" });
  }

  let config;
  try { config = getSuiteQLConfig(); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  // Deliberately separate from the TO RESTlet. If the env var isn't
  // set, fail fast — no fallback to the TO RESTlet that could mask a
  // misconfiguration and accidentally route SO traffic through the TO
  // deployment.
  const restletUrl = process.env.NS_RESTLET_FULFILL_SO_URL;
  if (!restletUrl) {
    return res.status(500).json({
      error: "NS_RESTLET_FULFILL_SO_URL is not configured. Deploy netsuite/fulfillSalesOrder.js — see netsuite/README.md.",
    });
  }

  const session = await getWaveSession(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const locationId = Number(session.locationId);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(500).json({ error: "Session has no valid locationId" });
  }

  const soIds = (session.soIds || []).map(String);
  if (soIds.length === 0) {
    return res.status(400).json({ error: "Wave has no soIds" });
  }

  // ─── Build FIFO scan queues ───
  // One list per itemId. Each entry is {binId, qty}. Oldest first,
  // preserving the order the picker scanned them. We mutate these
  // queues as we allocate.
  const scansByItem = {};
  const unavailableByItem = new Set();
  for (const ev of session.events || []) {
    if (!ev) continue;
    if (ev.type === "scan") {
      const iid = ev.itemId != null ? String(ev.itemId) : "";
      const qty = Number(ev.qty) || 0;
      const binId = ev.binId != null ? String(ev.binId) : "";
      if (!iid || !binId || qty <= 0) continue;
      (scansByItem[iid] ||= []).push({ binId, qty });
      continue;
    }
    if (ev.type === "mark_unavailable") {
      const iid = ev.itemId != null ? String(ev.itemId) : "";
      if (iid) unavailableByItem.add(iid);
      continue;
    }
    if (ev.type === "undo_unavailable") {
      const iid = ev.itemId != null ? String(ev.itemId) : "";
      if (iid) unavailableByItem.delete(iid);
      continue;
    }
  }
  const totalScanned = Object.values(scansByItem).reduce(
    (a, q) => a + q.reduce((s, r) => s + r.qty, 0), 0
  );
  if (totalScanned === 0 && unavailableByItem.size === 0) {
    return res.status(400).json({ error: "No scan events in this wave" });
  }

  // ─── Load SO headers (for oldest-first ordering) + lines ───
  const soIdList = soIds.map(Number).filter((n) => Number.isInteger(n));
  if (soIdList.length !== soIds.length) {
    return res.status(500).json({ error: "Malformed soIds in session" });
  }

  const { items: hdrRows } = await runSuiteQL(`
    SELECT id, tranid, trandate
    FROM transaction
    WHERE id IN (${soIdList.join(",")})
      AND type = 'SalesOrd'
    ORDER BY trandate ASC, id ASC
  `);
  const sortedHeaders = hdrRows.map((r) => ({
    id: String(r.id),
    tranId: r.tranid || null,
    orderDate: r.trandate || null,
  }));

  // quantityfulfilled is NOT_EXPOSED to SuiteQL's SEARCH channel in
  // this account (see api/sales-orders.js). All SOs in this wave are
  // Pending Fulfillment (filtered at list time), so qty_remaining ==
  // qty_ordered for every line here. SO quantity is stored negative;
  // ABS() for allocation arithmetic.
  const { items: lineRows } = await runSuiteQL(`
    SELECT
      tl.transaction AS so_id,
      tl.item AS item_id,
      ABS(tl.quantity) AS qty_ordered
    FROM transactionline tl
    WHERE tl.transaction IN (${soIdList.join(",")})
      AND tl.mainline = 'F'
      AND tl.location = ${locationId}
      AND tl.itemtype IN ('InvtPart', 'Assembly', 'Kit')
      AND ABS(tl.quantity) > 0
    ORDER BY tl.transaction, tl.linesequencenumber ASC
  `);
  const linesBySO = {};
  for (const r of lineRows) {
    const sid = String(r.so_id);
    (linesBySO[sid] ||= []).push({
      itemId: String(r.item_id),
      qtyRemaining: Number(r.qty_ordered) || 0,
    });
  }

  // ─── Allocate pool → SOs (oldest first) ───
  // Per-line allocation by consuming from the FIFO scan queue.
  const allocBySO = {};
  const shortagesBySO = {};
  for (const hdr of sortedHeaders) {
    const lines = linesBySO[hdr.id] || [];
    const thisAlloc = {};
    const thisShort = [];
    for (const line of lines) {
      let need = line.qtyRemaining;
      const queue = scansByItem[line.itemId] || [];
      const usedBins = [];
      while (need > 0 && queue.length > 0) {
        const front = queue[0];
        if (front.qty <= need) {
          usedBins.push({ binId: front.binId, qty: front.qty });
          need -= front.qty;
          queue.shift();
        } else {
          usedBins.push({ binId: front.binId, qty: need });
          front.qty -= need;
          need = 0;
        }
      }
      const pickedHere = usedBins.reduce((s, r) => s + r.qty, 0);
      if (pickedHere > 0) {
        (thisAlloc[line.itemId] ||= []).push(...usedBins);
      }
      if (need > 0) {
        thisShort.push({ itemId: line.itemId, short: need });
      }
    }
    allocBySO[hdr.id] = thisAlloc;
    if (thisShort.length > 0) shortagesBySO[hdr.id] = thisShort;
  }

  // ─── Call RESTlet once per SO with non-empty allocation ───
  const [restletBase, restletQs] = restletUrl.split("?");
  const restletQp = {};
  if (restletQs) {
    for (const pair of restletQs.split("&")) {
      const [k, ...rest] = pair.split("=");
      if (k) restletQp[decodeURIComponent(k)] = decodeURIComponent(rest.join("="));
    }
  }

  const results = [];
  for (const hdr of sortedHeaders) {
    const alloc = allocBySO[hdr.id];
    const hasAlloc = alloc && Object.keys(alloc).length > 0;
    const short = shortagesBySO[hdr.id] || [];
    // Split shortages by the picker's intent:
    //   - unavailable: picker tapped "Unavailable" in the wave, admin
    //     must follow up with the customer.
    //   - pending: picker didn't reach it (just ran out of time /
    //     forgot to mark it). The SO should stay Partially Fulfilled
    //     so someone else can finish the pick.
    const unavailableShort = short.filter((s) => unavailableByItem.has(s.itemId));
    const pendingShort = short.filter((s) => !unavailableByItem.has(s.itemId));

    if (!hasAlloc) {
      results.push({
        soId: hdr.id,
        tranId: hdr.tranId,
        status: "skipped_no_allocation",
        shortages: short,
        unavailable: unavailableShort,
        fulfillmentId: null,
      });
      continue;
    }

    const lines = Object.entries(alloc).map(([itemId, bins]) => {
      const merged = {};
      for (const b of bins) {
        merged[b.binId] = (merged[b.binId] || 0) + b.qty;
      }
      return {
        itemId,
        bins: Object.entries(merged).map(([binId, quantity]) => ({ binId, quantity })),
      };
    });

    // Ship if everything unpicked was explicitly flagged unavailable.
    // That means the picker signed off on closing the pack even though
    // it's short — the remaining shortage is a customer-service matter,
    // not "try again later."
    const setShipped = pendingShort.length === 0;
    const body = {
      salesOrderId: hdr.id,
      setShipped,
      lines,
    };

    try {
      const auth = generateOAuthHeader("POST", restletBase, restletQp, config);
      const resp = await fetch(restletUrl, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      if (!resp.ok || !data?.fulfillmentId) {
        results.push({
          soId: hdr.id,
          tranId: hdr.tranId,
          status: "error",
          error: (typeof data === "object" && (data?.["o:errorDetails"]?.[0]?.detail || data?.error?.message || data?.message)) ||
                 (typeof data === "string" ? data.slice(0, 300) : `RESTlet returned ${resp.status}`),
          shortages: short,
          fulfillmentId: null,
          requestPayload: body,
        });
        continue;
      }
      results.push({
        soId: hdr.id,
        tranId: hdr.tranId,
        status: setShipped ? "shipped" : "picked_partial",
        fulfillmentId: String(data.fulfillmentId),
        linesFulfilled: data.linesFulfilled || 0,
        shortages: short,
        unavailable: unavailableShort,
      });
    } catch (e) {
      results.push({
        soId: hdr.id,
        tranId: hdr.tranId,
        status: "error",
        error: `RESTlet call threw: ${e.message}`,
        shortages: short,
        unavailable: unavailableShort,
        fulfillmentId: null,
      });
    }
  }

  // ─── Shortage log (admin follow-up) ───────────────────────────
  // Anything the picker flagged unavailable is something a customer-
  // service person needs to act on — cancel the line, refund, offer a
  // substitute, etc. Log to KV for 30 days under shortage:{ts}:{soId}
  // so a future admin view (or email digest) can surface them.
  const SHORTAGE_LOG_TTL = 60 * 60 * 24 * 30;
  for (const r of results) {
    if (!r.unavailable || r.unavailable.length === 0) continue;
    try {
      const key = `shortage:${Date.now()}:${r.soId}`;
      await kv.set(
        key,
        {
          timestamp: new Date().toISOString(),
          soId: r.soId,
          tranId: r.tranId,
          pickerName: session.pickerName,
          locationId: session.locationId,
          fulfillmentId: r.fulfillmentId,
          shortStatus: r.status,
          items: r.unavailable.map((s) => ({ itemId: s.itemId, short: s.short })),
        },
        { ex: SHORTAGE_LOG_TTL },
      );
    } catch (e) {
      console.error("shortage log failed for", r.soId, e?.message);
    }
  }

  const anySuccess = results.some((r) => r.fulfillmentId);
  const allError = results.every((r) => r.status === "error");

  if (anySuccess) {
    try {
      await deleteWaveSession(session);
    } catch (e) {
      console.error("deleteWaveSession after fulfill failed:", e);
    }
  } else if (!allError) {
    // Nothing was successful but not all errored — persist for retry.
    try {
      await writeWaveSession({
        ...session,
        status: "fulfilled_partial",
        updatedAt: new Date().toISOString(),
      });
    } catch {}
  }

  return res.status(anySuccess ? 200 : 500).json({
    status: anySuccess ? "complete" : "failed",
    results,
    waveShortages: Object.entries(shortagesBySO).map(([soId, short]) => ({ soId, short })),
  });
}
