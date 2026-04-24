/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * fulfillSalesOrder — creates an Item Fulfillment against a Sales Order
 * via SuiteScript's record.transform(SALES_ORDER → ITEM_FULFILLMENT).
 *
 * Separate from receiveTransferOrder.js on purpose: the TO receipt path
 * took work to get right, and we don't want unrelated SO changes to be
 * able to regress it. This RESTlet is self-contained — deploy it at a
 * new script/deployment record and point NS_RESTLET_FULFILL_SO_URL at
 * it.
 *
 * Why a RESTlet and not the REST Record API:
 *   The REST `!transform/itemFulfillment` endpoint pre-populates each
 *   line's inventoryDetail with an NS-chosen auto-allocation and treats
 *   that subrecord as static. Appending our own bin assignments via REST
 *   produces "total inventory detail quantity must be N" or "static
 *   sublist" errors depending on the item's setup. SuiteScript's
 *   dynamic record API can remove the pre-populated assignments before
 *   adding ours, sidestepping that trap.
 *
 * ─── Request body ────────────────────────────────────────────
 * {
 *   "salesOrderId": "12345",
 *   "setShipped":   true,               // optional — if true, IF
 *                                       // shipstatus=C before save.
 *                                       // Default false (stays
 *                                       // "Picked" for finalize later).
 *   "lines": [                           // required, non-empty
 *     {
 *       "itemId": "7566",
 *       "bins": [
 *         { "binId": "2995", "quantity": 1 },
 *         { "binId": "3106", "quantity": 2 }
 *       ]
 *     },
 *     ...
 *   ]
 * }
 *
 * ─── Response ────────────────────────────────────────────────
 * Success: { status:"created", fulfillmentId, linesFulfilled, salesOrderId, shipped }
 * Failure: 500 with thrown error.
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

  function createFulfillment(soId, specByItemId, setShipped) {
    var ff = record.transform({
      fromType: record.Type.SALES_ORDER,
      fromId: soId,
      toType: record.Type.ITEM_FULFILLMENT,
      isDynamic: true,
    });

    var lineCount = ff.getLineCount({ sublistId: 'item' });
    log.audit({ title: 'fulfillSalesOrder.sublistSize', details: { soId: soId, lineCount: lineCount } });

    var touched = 0;
    for (var i = 0; i < lineCount; i++) {
      ff.selectLine({ sublistId: 'item', line: i });
      var itemObj = ff.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
      var itemId = itemObj != null ? String(itemObj) : '';
      var spec = specByItemId[itemId];

      if (spec && spec.totalQty > 0) {
        ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: spec.totalQty });

        var invDetail = ff.getCurrentSublistSubrecord({
          sublistId: 'item',
          fieldId: 'inventorydetail',
        });
        var existing = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
        for (var j = existing - 1; j >= 0; j--) {
          invDetail.removeLine({ sublistId: 'inventoryassignment', line: j });
        }
        for (var k = 0; k < spec.bins.length; k++) {
          var b = spec.bins[k];
          if (!b.binId || !b.qty || b.qty <= 0) continue;
          invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
          invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: b.binId });
          invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: b.qty });
          invDetail.commitLine({ sublistId: 'inventoryassignment' });
        }

        // Mark the spec consumed so a second sublist row carrying the
        // same itemId (kits, lots, multi-location SO lines) doesn't
        // double-claim the same picked bin allocation.
        spec.totalQty = 0;
        spec.bins = [];

        touched++;
      } else {
        ff.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
      }

      ff.commitLine({ sublistId: 'item' });
    }

    if (touched === 0) {
      throw Error('No fulfillment lines matched. Expected itemId one of: ' + Object.keys(specByItemId).join(', '));
    }

    if (setShipped) {
      try {
        ff.setValue({ fieldId: 'shipstatus', value: 'C' });
      } catch (e) {
        log.debug({ title: 'fulfillSalesOrder.shipstatusSetValueFailed', details: e.message });
      }
    }

    var fulfillmentId = ff.save({ enableSourcing: true, ignoreMandatoryFields: false });

    if (setShipped) {
      try {
        var cur = search.lookupFields({ type: record.Type.ITEM_FULFILLMENT, id: fulfillmentId, columns: ['shipstatus'] });
        var curStatus = Array.isArray(cur.shipstatus) && cur.shipstatus[0] ? cur.shipstatus[0].value : cur.shipstatus;
        if (curStatus !== 'C') {
          record.submitFields({
            type: record.Type.ITEM_FULFILLMENT,
            id: fulfillmentId,
            values: { shipstatus: 'C' },
          });
        }
      } catch (e) {
        log.error({ title: 'fulfillSalesOrder.shipstatusForceFailed', details: e.message });
      }
    }

    return { fulfillmentId: String(fulfillmentId), touched: touched };
  }

  function doPost(body) {
    log.audit({ title: 'fulfillSalesOrder.request', details: body });

    var soId       = body && body.salesOrderId ? String(body.salesOrderId) : '';
    var lines      = body && Array.isArray(body.lines) ? body.lines : [];
    var setShipped = !!(body && body.setShipped);

    if (!soId) { throw Error('salesOrderId is required'); }
    if (lines.length === 0) { throw Error('lines[] must be non-empty'); }

    // Accept either aggregated { itemId, bins:[{binId, quantity}] } or
    // flat { itemId, binId, quantity } line shapes.
    var specByItemId = {};
    for (var fi = 0; fi < lines.length; fi++) {
      var L = lines[fi];
      var iid = L.itemId != null ? String(L.itemId) : '';
      if (!iid) { continue; }
      if (!specByItemId[iid]) { specByItemId[iid] = { totalQty: 0, bins: [] }; }

      if (Array.isArray(L.bins)) {
        for (var bi = 0; bi < L.bins.length; bi++) {
          var row = L.bins[bi];
          var rqty = Number(row.quantity) || 0;
          if (!row.binId || rqty <= 0) { continue; }
          specByItemId[iid].bins.push({ binId: String(row.binId), qty: rqty });
          specByItemId[iid].totalQty += rqty;
        }
      } else {
        var q = Number(L.quantity) || 0;
        if (q > 0 && L.binId) {
          specByItemId[iid].bins.push({ binId: String(L.binId), qty: q });
          specByItemId[iid].totalQty += q;
        }
      }
    }
    if (Object.keys(specByItemId).length === 0) {
      throw Error('fulfillSalesOrder: no lines with itemId + bin data');
    }

    var result = createFulfillment(soId, specByItemId, setShipped);
    log.audit({ title: 'fulfillSalesOrder.created', details: { soId: soId, setShipped: setShipped, result: result } });

    return {
      status: 'created',
      fulfillmentId: result.fulfillmentId,
      linesFulfilled: result.touched,
      salesOrderId: soId,
      shipped: !!setShipped,
    };
  }

  return { post: doPost };
});
