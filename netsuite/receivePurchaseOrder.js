/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * receivePurchaseOrder — creates an Item Receipt against a Purchase
 * Order via SuiteScript's record.transform(PURCHASE_ORDER → ITEM_RECEIPT).
 *
 * Why a RESTlet and not the REST Record API:
 *   The REST `!transform/itemReceipt` endpoint pre-populates each line's
 *   inventoryDetail with an NS-chosen auto-allocation and treats that
 *   subrecord as static. Appending our own bin assignments via REST
 *   produces "invalid sublist or line item operation … static sublist"
 *   errors, and the binnumber field rejects a bin *name* (it wants the
 *   bin's internal id). SuiteScript's dynamic record API can remove the
 *   pre-populated assignments before adding ours, keyed by bin internal
 *   id, sidestepping both traps. This mirrors receiveTransferOrder.js
 *   and fulfillSalesOrder.js, which moved off raw REST for the same
 *   reasons.
 *
 * Lines are matched on the transformed IR's sublist by `itemId`, not by
 * orderLine — the orderLine offset on a transformed receipt is fragile
 * (see api/transfer-orders/[id]/fulfill.js). A spec is consumed after
 * the first matching line is touched so a SKU that appears on two PO
 * lines doesn't get double-received.
 *
 * ─── Request body ────────────────────────────────────────────
 * {
 *   "purchaseOrderId": "123456",
 *   "lines": [                              // required, non-empty
 *     {
 *       "itemId": "7566",
 *       "quantity": 10,                     // optional; defaults to sum(bins)
 *       "bins": [                           // optional — omit for
 *         { "binId": "2995", "quantity": 7 },//   non-bin-managed items
 *         { "binId": "3106", "quantity": 3 } //   (NS auto-allocates)
 *       ]
 *     }
 *   ]
 * }
 *
 * `binId` is the bin's INTERNAL id. The caller (api/receive-po.js)
 * resolves scanned bin names → ids before calling this RESTlet.
 *
 * ─── Response ────────────────────────────────────────────────
 * Success: { status:"created", receiptId, linesReceived, purchaseOrderId }
 * Failure: 500 with a thrown error.
 */
define(['N/record', 'N/log'], function (record, log) {

  function createReceipt(poId, specByItemId) {
    var receipt = record.transform({
      fromType: record.Type.PURCHASE_ORDER,
      fromId: poId,
      toType: record.Type.ITEM_RECEIPT,
      isDynamic: true,
    });

    var lineCount = receipt.getLineCount({ sublistId: 'item' });
    log.audit({ title: 'receivePurchaseOrder.sublistSize', details: lineCount });

    var touched = 0;
    for (var i = 0; i < lineCount; i++) {
      receipt.selectLine({ sublistId: 'item', line: i });
      var itemObj = receipt.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
      var itemId = itemObj != null ? String(itemObj) : '';
      var spec = specByItemId[itemId];

      if (spec && !spec.consumed && spec.totalQty > 0) {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: spec.totalQty });

        // Only touch inventoryDetail when we have explicit bin targets.
        // Bin-managed items with bins[] land exactly where scanned;
        // items without bins fall through to NS auto-allocation.
        if (spec.bins.length > 0) {
          var invDetail = receipt.getCurrentSublistSubrecord({
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
        }

        spec.consumed = true;
        touched++;
      } else {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
      }

      receipt.commitLine({ sublistId: 'item' });
    }

    if (touched === 0) {
      throw Error('No receipt lines matched. Expected itemId one of: ' + Object.keys(specByItemId).join(', '));
    }

    var receiptId = receipt.save({ enableSourcing: true, ignoreMandatoryFields: false });
    return { receiptId: String(receiptId), touched: touched };
  }

  function doPost(body) {
    log.audit({ title: 'receivePurchaseOrder.request', details: body });

    var poId  = body && body.purchaseOrderId ? String(body.purchaseOrderId) : '';
    var lines = body && Array.isArray(body.lines) ? body.lines : [];

    if (!poId) { throw Error('purchaseOrderId is required'); }
    if (lines.length === 0) { throw Error('lines[] must be non-empty'); }

    // Roll up by itemId so repeat rows for the same item merge cleanly.
    var specByItemId = {};
    for (var fi = 0; fi < lines.length; fi++) {
      var L = lines[fi];
      var iid = L.itemId != null ? String(L.itemId) : '';
      if (!iid) { continue; }
      if (!specByItemId[iid]) { specByItemId[iid] = { totalQty: 0, bins: [], consumed: false }; }

      var binsProvided = false;
      if (Array.isArray(L.bins)) {
        for (var bi = 0; bi < L.bins.length; bi++) {
          var row = L.bins[bi];
          var rqty = Number(row.quantity) || 0;
          if (!row.binId || rqty <= 0) { continue; }
          specByItemId[iid].bins.push({ binId: String(row.binId), qty: rqty });
          specByItemId[iid].totalQty += rqty;
          binsProvided = true;
        }
      }
      // No bin rows → take the line-level quantity (non-bin-managed item).
      if (!binsProvided) {
        var q = Number(L.quantity) || 0;
        if (q > 0) { specByItemId[iid].totalQty += q; }
      }
    }

    var keys = Object.keys(specByItemId);
    var anyQty = keys.some(function (k) { return specByItemId[k].totalQty > 0; });
    if (!anyQty) {
      throw Error('lines[] must include at least one item with quantity > 0');
    }

    var result = createReceipt(poId, specByItemId);
    log.audit({ title: 'receivePurchaseOrder.created', details: { receiptId: result.receiptId, touched: result.touched } });

    return {
      status: 'created',
      receiptId: result.receiptId,
      linesReceived: result.touched,
      purchaseOrderId: poId,
    };
  }

  return { post: doPost };
});
