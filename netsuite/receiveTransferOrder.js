/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * receiveTransferOrder — creates an Item Receipt against a TO via
 * SuiteScript after the picker app has already shipped an Item
 * Fulfillment. We keep this RESTlet because every REST Record API
 * variant for creating a TO Item Receipt is rejected in this account:
 *   - POST transferOrder/{id}/!transform/itemReceipt     → "invalid reference {id}"
 *   - POST itemFulfillment/{id}/!transform/itemReceipt   → "transformation not allowed"
 *   - POST itemreceipt directly with createdFrom         → asks for [entity]
 *
 * ─── Request body ────────────────────────────────────────────
 * {
 *   "fulfillmentId":   "526977",
 *   "transferOrderId": "523165",
 *   "destBinId":       "123",
 *   "lines": [ { "orderLine": 0, "quantity": 1 }, ... ],
 *   "diagnose":         true   // optional — return the probe matrix
 *                              // without saving anything
 * }
 *
 * ─── Response ────────────────────────────────────────────────
 * On success: { status: "created", receiptId, strategy, linesReceived }
 * `strategy` names which construction path worked so the next caller
 * can skip the probe matrix.
 *
 * On failure: 500 with a `probe` array documenting every path tried and
 * the exact error each one returned. That report is the authoritative
 * answer to "is there any way to create this IR programmatically."
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log'], function (record, search, runtime, log) {

  // ─── Diagnostics ───────────────────────────────────────────────
  // Pull the state NS will consult when deciding whether to allow a
  // TO-receipt transform. Runs in-RESTlet because `getPermission` /
  // runtime.getCurrentScript() are not exposed to REST consumers.
  function collectDiagnostics(fulfillmentId, toId) {
    var d = { fulfillment: {}, transferOrder: {}, role: {}, features: {}, errors: [] };

    try {
      var ffLookup = search.lookupFields({
        type: record.Type.ITEM_FULFILLMENT,
        id: fulfillmentId,
        columns: ['shipstatus', 'status', 'createdfrom', 'trandate', 'postingperiod'],
      });
      d.fulfillment = ffLookup;
    } catch (e) { d.errors.push('ffLookup: ' + e.message); }

    try {
      var toLookup = search.lookupFields({
        type: record.Type.TRANSFER_ORDER,
        id: toId,
        columns: ['status', 'statusref', 'location', 'transferlocation', 'trandate'],
      });
      d.transferOrder = toLookup;
    } catch (e) { d.errors.push('toLookup: ' + e.message); }

    try {
      var u = runtime.getCurrentUser();
      d.role = {
        roleId: u.role,
        roleName: u.roleCenter,
        userName: u.name,
        subsidiary: u.subsidiary,
        itemReceiptPerm: u.getPermission({ name: 'TRAN_ITEMRCPT' }),
        transferOrderPerm: u.getPermission({ name: 'TRAN_TRNFRORD' }),
        itemFulfillmentPerm: u.getPermission({ name: 'TRAN_ITEMSHIP' }),
      };
    } catch (e) { d.errors.push('runtimeUser: ' + e.message); }

    try {
      d.features.advancedBinSerial = runtime.isFeatureInEffect({ feature: 'ADVBINSERIALMGMT' });
      d.features.multiLocInv        = runtime.isFeatureInEffect({ feature: 'MULTILOCINVT' });
      d.features.bins               = runtime.isFeatureInEffect({ feature: 'BINMANAGEMENT' });
      d.features.inboundShipment    = runtime.isFeatureInEffect({ feature: 'INBOUNDSHIPMENT' });
      d.features.advancedReceiving  = runtime.isFeatureInEffect({ feature: 'ADVANCEDRECEIVING' });
    } catch (e) { d.errors.push('features: ' + e.message); }

    return d;
  }

  // ─── Probe matrix ──────────────────────────────────────────────
  // Each probe returns { name, ok, recordObj?, error? } so we can see
  // which paths NS actually allows vs which it rejects and why.
  function runProbes(fulfillmentId, toId) {
    var probes = [];

    function probe(name, fn) {
      try {
        var recordObj = fn();
        probes.push({ name: name, ok: true, recordObjPresent: !!recordObj });
        return recordObj;
      } catch (e) {
        probes.push({
          name: name,
          ok: false,
          error: e.message || String(e),
          name_: e.name,
          id: e.id,
        });
        return null;
      }
    }

    // A. record.transform variations — the canonical path
    probe('transform:IF->IR:dyn', function () {
      return record.transform({
        fromType: record.Type.ITEM_FULFILLMENT,
        fromId: fulfillmentId,
        toType: record.Type.ITEM_RECEIPT,
        isDynamic: true,
      });
    });

    probe('transform:IF->IR:static', function () {
      return record.transform({
        fromType: record.Type.ITEM_FULFILLMENT,
        fromId: fulfillmentId,
        toType: record.Type.ITEM_RECEIPT,
        isDynamic: false,
      });
    });

    probe('transform:IF->IR:dyn+defaults', function () {
      return record.transform({
        fromType: record.Type.ITEM_FULFILLMENT,
        fromId: fulfillmentId,
        toType: record.Type.ITEM_RECEIPT,
        isDynamic: true,
        defaultValues: { recordmode: 'receipt' },
      });
    });

    probe('transform:TO->IR:dyn', function () {
      return record.transform({
        fromType: record.Type.TRANSFER_ORDER,
        fromId: toId,
        toType: record.Type.ITEM_RECEIPT,
        isDynamic: true,
      });
    });

    probe('transform:TO->IR:dyn+ifhint', function () {
      return record.transform({
        fromType: record.Type.TRANSFER_ORDER,
        fromId: toId,
        toType: record.Type.ITEM_RECEIPT,
        isDynamic: true,
        defaultValues: { itemfulfillment: fulfillmentId },
      });
    });

    probe('transform:TO->IR:dyn+createdfrom', function () {
      return record.transform({
        fromType: record.Type.TRANSFER_ORDER,
        fromId: toId,
        toType: record.Type.ITEM_RECEIPT,
        isDynamic: true,
        defaultValues: { createdfrom: fulfillmentId },
      });
    });

    // B. record.create variations
    var createKeys = [
      { transferorder: fulfillmentId },
      { transferorder: toId },
      { itemfulfillment: fulfillmentId },
      { fromtransaction: fulfillmentId },
      { fromtransaction: toId },
      { sourcerecord: fulfillmentId },
      { sourcerecord: toId },
      { createdfrom: fulfillmentId, recordmode: 'receipt' },
      { transaction: fulfillmentId, recordmode: 'receipt' },
    ];
    for (var i = 0; i < createKeys.length; i++) {
      (function (dv, label) {
        probe('create:IR:' + label, function () {
          return record.create({
            type: record.Type.ITEM_RECEIPT,
            isDynamic: true,
            defaultValues: dv,
          });
        });
      })(createKeys[i], JSON.stringify(createKeys[i]));
    }

    return probes;
  }

  // ─── Actually save a receipt once we have a viable record object ─
  function populateAndSave(receipt, qtyByOrderLine, destBinId) {
    var lineCount = receipt.getLineCount({ sublistId: 'item' });
    var touched = 0;

    for (var i = 0; i < lineCount; i++) {
      receipt.selectLine({ sublistId: 'item', line: i });
      var orderLine = receipt.getCurrentSublistValue({ sublistId: 'item', fieldId: 'orderline' });
      var qty = qtyByOrderLine[String(orderLine)];

      if (qty && qty > 0) {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });

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
      throw Error('No receipt lines matched. Expected orderLine one of: ' + Object.keys(qtyByOrderLine).join(', '));
    }

    var receiptId = receipt.save({ enableSourcing: true, ignoreMandatoryFields: false });
    return { receiptId: String(receiptId), touched: touched };
  }

  function doPost(body) {
    log.audit({ title: 'receiveTransferOrder.request', details: body });

    var fulfillmentId = body && body.fulfillmentId ? String(body.fulfillmentId) : '';
    var toId = body && body.transferOrderId ? String(body.transferOrderId) : '';
    var destBinId = body && body.destBinId ? String(body.destBinId) : '';
    var lines = body && Array.isArray(body.lines) ? body.lines : [];
    var diagnose = !!(body && body.diagnose);

    if (!fulfillmentId) { throw Error('fulfillmentId is required'); }
    if (!toId) { throw Error('transferOrderId is required'); }
    if (!diagnose && !destBinId) { throw Error('destBinId is required'); }
    if (!diagnose && lines.length === 0) { throw Error('lines[] must be non-empty'); }

    var diagnostics = collectDiagnostics(fulfillmentId, toId);
    log.audit({ title: 'receiveTransferOrder.diagnostics', details: diagnostics });

    var probes = runProbes(fulfillmentId, toId);
    log.audit({ title: 'receiveTransferOrder.probes', details: probes });

    // Diagnostic-only mode: don't save, return the full report.
    if (diagnose) {
      return {
        status: 'diagnose',
        transferOrderId: toId,
        fulfillmentId: fulfillmentId,
        diagnostics: diagnostics,
        probes: probes,
      };
    }

    // Find the first probe that produced a record and try to save.
    // Re-run the winning probe to get a fresh record object (probes
    // throw them away) and then walk the sublist and save.
    var qtyByOrderLine = {};
    for (var li = 0; li < lines.length; li++) {
      var qty = Number(lines[li].quantity) || 0;
      if (qty > 0) { qtyByOrderLine[String(lines[li].orderLine)] = qty; }
    }

    var strategy = null;
    var receipt = null;
    var saveError = null;

    var winningProbes = [];
    for (var p = 0; p < probes.length; p++) {
      if (probes[p].ok) winningProbes.push(probes[p].name);
    }
    log.audit({ title: 'receiveTransferOrder.winners', details: winningProbes });

    for (var w = 0; w < winningProbes.length && !strategy; w++) {
      var name = winningProbes[w];
      try {
        receipt = rebuildByName(name, fulfillmentId, toId);
        if (receipt) {
          var result = populateAndSave(receipt, qtyByOrderLine, destBinId);
          log.audit({ title: 'receiveTransferOrder.created', details: { strategy: name, receiptId: result.receiptId } });
          return {
            status: 'created',
            strategy: name,
            receiptId: result.receiptId,
            linesReceived: result.touched,
            transferOrderId: toId,
          };
        }
      } catch (e) {
        saveError = { strategy: name, message: e.message };
        log.error({ title: 'receiveTransferOrder.saveFailed', details: saveError });
      }
    }

    // Nothing worked. Throw a rich error that includes the probe report
    // so the caller can log it and tell support exactly what NS said.
    throw Error(JSON.stringify({
      message: 'No receipt construction path succeeded',
      diagnostics: diagnostics,
      probes: probes,
      saveError: saveError,
    }));
  }

  // Re-run a probe by name so we get a fresh record to save.
  function rebuildByName(name, fulfillmentId, toId) {
    if (name === 'transform:IF->IR:dyn') {
      return record.transform({ fromType: record.Type.ITEM_FULFILLMENT, fromId: fulfillmentId, toType: record.Type.ITEM_RECEIPT, isDynamic: true });
    }
    if (name === 'transform:IF->IR:static') {
      return record.transform({ fromType: record.Type.ITEM_FULFILLMENT, fromId: fulfillmentId, toType: record.Type.ITEM_RECEIPT, isDynamic: false });
    }
    if (name === 'transform:IF->IR:dyn+defaults') {
      return record.transform({ fromType: record.Type.ITEM_FULFILLMENT, fromId: fulfillmentId, toType: record.Type.ITEM_RECEIPT, isDynamic: true, defaultValues: { recordmode: 'receipt' } });
    }
    if (name === 'transform:TO->IR:dyn') {
      return record.transform({ fromType: record.Type.TRANSFER_ORDER, fromId: toId, toType: record.Type.ITEM_RECEIPT, isDynamic: true });
    }
    if (name === 'transform:TO->IR:dyn+ifhint') {
      return record.transform({ fromType: record.Type.TRANSFER_ORDER, fromId: toId, toType: record.Type.ITEM_RECEIPT, isDynamic: true, defaultValues: { itemfulfillment: fulfillmentId } });
    }
    if (name === 'transform:TO->IR:dyn+createdfrom') {
      return record.transform({ fromType: record.Type.TRANSFER_ORDER, fromId: toId, toType: record.Type.ITEM_RECEIPT, isDynamic: true, defaultValues: { createdfrom: fulfillmentId } });
    }
    var m = /^create:IR:(.+)$/.exec(name);
    if (m) {
      var dv = JSON.parse(m[1]);
      return record.create({ type: record.Type.ITEM_RECEIPT, isDynamic: true, defaultValues: dv });
    }
    return null;
  }

  return {
    post: doPost,
  };
});
