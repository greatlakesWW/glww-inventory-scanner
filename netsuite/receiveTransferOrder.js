/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * receiveTransferOrder — creates an Item Receipt against a TO via
 * SuiteScript's record.transform(TRANSFER_ORDER → ITEM_RECEIPT).
 *
 * We keep this RESTlet (as opposed to using the REST Record API
 * directly) because every REST variant is rejected in this account:
 *   - POST transferOrder/{id}/!transform/itemReceipt     → "invalid reference {id}"
 *   - POST itemFulfillment/{id}/!transform/itemReceipt   → "transformation not allowed"
 *   - POST itemreceipt                                   → asks for [entity]
 *
 * A diagnostic probe matrix (see commit 586bab4) proved that
 * TRANSFER_ORDER → ITEM_RECEIPT works in SuiteScript but
 * ITEM_FULFILLMENT → ITEM_RECEIPT is genuinely blocked. TO→IR requires
 * the TO to be in "Pending Receipt" status, i.e. all linked
 * Item Fulfillments must be shipStatus="C" (Shipped). The caller is
 * responsible for that precondition (fulfill.js PATCHes it).
 *
 * ─── Request body ────────────────────────────────────────────
 * {
 *   "transferOrderId": "523165",
 *   "fulfillmentId":   "526977",   // informational, audited
 *   "destBinId":       "4002",      // required, bin internal id
 *   "lines": [                      // required, non-empty
 *     { "itemId": "12345", "quantity": 1 },
 *     { "itemId": "67890", "quantity": 2 }
 *   ],
 *   "diagnose":         false        // optional — run probe matrix only
 * }
 *
 * `itemId` is used to match rows on the transformed IR's sublist.
 * The caller has itemIds in hand (from the TO sublist or session events);
 * matching by itemId avoids the orderLine-offset fragility that tripped
 * up earlier iterations of this flow.
 *
 * ─── Response ────────────────────────────────────────────────
 * On success: { status: "created", receiptId, linesReceived, transferOrderId }
 * On diagnose: { status: "diagnose", diagnostics, probes }
 * On failure: 500 with a detail message.
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log'], function (record, search, runtime, log) {

  // ─── Diagnostics (diagnose=true only) ──────────────────────────
  function collectDiagnostics(fulfillmentId, toId) {
    var d = { fulfillment: {}, transferOrder: {}, role: {}, features: {}, errors: [] };

    try {
      d.fulfillment = search.lookupFields({
        type: record.Type.ITEM_FULFILLMENT,
        id: fulfillmentId,
        columns: ['status', 'createdfrom', 'trandate', 'postingperiod'],
      });
    } catch (e) { d.errors.push('ffLookup: ' + e.message); }

    try {
      d.transferOrder = search.lookupFields({
        type: record.Type.TRANSFER_ORDER,
        id: toId,
        columns: ['status', 'statusref', 'location', 'transferlocation', 'trandate'],
      });
    } catch (e) { d.errors.push('toLookup: ' + e.message); }

    try {
      var u = runtime.getCurrentUser();
      d.role = {
        roleId: u.role,
        userName: u.name,
        subsidiary: u.subsidiary,
        itemReceiptPerm: u.getPermission({ name: 'TRAN_ITEMRCPT' }),
        transferOrderPerm: u.getPermission({ name: 'TRAN_TRNFRORD' }),
        itemFulfillmentPerm: u.getPermission({ name: 'TRAN_ITEMSHIP' }),
      };
    } catch (e) { d.errors.push('runtimeUser: ' + e.message); }

    try {
      d.features.multiLocInv       = runtime.isFeatureInEffect({ feature: 'MULTILOCINVT' });
      d.features.bins              = runtime.isFeatureInEffect({ feature: 'BINMANAGEMENT' });
      d.features.inboundShipment   = runtime.isFeatureInEffect({ feature: 'INBOUNDSHIPMENT' });
      d.features.advancedReceiving = runtime.isFeatureInEffect({ feature: 'ADVANCEDRECEIVING' });
    } catch (e) { d.errors.push('features: ' + e.message); }

    return d;
  }

  function runProbes(fulfillmentId, toId) {
    var probes = [];
    function probe(name, fn) {
      try {
        var obj = fn();
        probes.push({ name: name, ok: true, recordObjPresent: !!obj });
      } catch (e) {
        probes.push({ name: name, ok: false, error: e.message || String(e), name_: e.name, id: e.id });
      }
    }
    probe('transform:IF->IR:dyn', function () {
      return record.transform({ fromType: record.Type.ITEM_FULFILLMENT, fromId: fulfillmentId, toType: record.Type.ITEM_RECEIPT, isDynamic: true });
    });
    probe('transform:TO->IR:dyn', function () {
      return record.transform({ fromType: record.Type.TRANSFER_ORDER, fromId: toId, toType: record.Type.ITEM_RECEIPT, isDynamic: true });
    });
    return probes;
  }

  // ─── Production path: TO → IR ──────────────────────────────────
  function createReceipt(toId, fulfillmentId, qtyByItemId, destBinId) {
    var receipt = record.transform({
      fromType: record.Type.TRANSFER_ORDER,
      fromId: toId,
      toType: record.Type.ITEM_RECEIPT,
      isDynamic: true,
    });

    // The transformed receipt's sublist has one row per TO line that
    // still has shipped-but-not-received quantity against ANY fulfillment
    // of this TO. If multiple IFs exist, ALL of their shipped lines are
    // in this sublist — we filter to just the lines whose itemId matches
    // the current request, so IF boundaries stay respected.
    var lineCount = receipt.getLineCount({ sublistId: 'item' });
    log.audit({ title: 'receiveTransferOrder.sublistSize', details: lineCount });

    var touched = 0;
    for (var i = 0; i < lineCount; i++) {
      receipt.selectLine({ sublistId: 'item', line: i });
      var itemObj = receipt.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
      var itemId = itemObj != null ? String(itemObj) : '';
      var qty = qtyByItemId[itemId];

      if (qty && qty > 0) {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });

        // Override the inventoryDetail subrecord so stock lands into the
        // configured destination bin rather than whatever NS auto-picks.
        var invDetail = receipt.getCurrentSublistSubrecord({
          sublistId: 'item',
          fieldId: 'inventorydetail',
        });
        var existing = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
        for (var j = existing - 1; j >= 0; j--) {
          invDetail.removeLine({ sublistId: 'inventoryassignment', line: j });
        }
        invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: destBinId });
        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty });
        invDetail.commitLine({ sublistId: 'inventoryassignment' });

        touched++;
      } else {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
      }

      receipt.commitLine({ sublistId: 'item' });
    }

    if (touched === 0) {
      throw Error('No receipt lines matched. Expected itemId one of: ' + Object.keys(qtyByItemId).join(', '));
    }

    var receiptId = receipt.save({ enableSourcing: true, ignoreMandatoryFields: false });
    return { receiptId: String(receiptId), touched: touched };
  }

  function doPost(body) {
    log.audit({ title: 'receiveTransferOrder.request', details: body });

    var fulfillmentId = body && body.fulfillmentId ? String(body.fulfillmentId) : '';
    var toId          = body && body.transferOrderId ? String(body.transferOrderId) : '';
    var destBinId     = body && body.destBinId ? String(body.destBinId) : '';
    var lines         = body && Array.isArray(body.lines) ? body.lines : [];
    var diagnose      = !!(body && body.diagnose);

    if (!toId) { throw Error('transferOrderId is required'); }

    if (diagnose) {
      // diagnose mode is intentionally permissive on fulfillmentId
      // (for poking at arbitrary TO states)
      return {
        status: 'diagnose',
        transferOrderId: toId,
        fulfillmentId: fulfillmentId,
        diagnostics: collectDiagnostics(fulfillmentId, toId),
        probes: runProbes(fulfillmentId, toId),
      };
    }

    if (!destBinId) { throw Error('destBinId is required'); }
    if (lines.length === 0) { throw Error('lines[] must be non-empty'); }

    var qtyByItemId = {};
    for (var li = 0; li < lines.length; li++) {
      var iid = lines[li].itemId != null ? String(lines[li].itemId) : '';
      var qty = Number(lines[li].quantity) || 0;
      if (iid && qty > 0) {
        qtyByItemId[iid] = (qtyByItemId[iid] || 0) + qty;
      }
    }
    if (Object.keys(qtyByItemId).length === 0) {
      throw Error('lines[] must include at least one { itemId, quantity>0 } entry');
    }

    var result = createReceipt(toId, fulfillmentId, qtyByItemId, destBinId);
    log.audit({ title: 'receiveTransferOrder.created', details: { receiptId: result.receiptId, touched: result.touched } });

    return {
      status: 'created',
      receiptId: result.receiptId,
      linesReceived: result.touched,
      transferOrderId: toId,
    };
  }

  return {
    post: doPost,
  };
});
