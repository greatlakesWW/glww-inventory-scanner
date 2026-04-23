/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * receiveTransferOrder — RESTlet companion to the Pick Mode fulfill
 * endpoint (api/transfer-orders/[id]/fulfill.js).
 *
 * The picker app creates the Item Fulfillment via the standard REST
 * Record API `!transform/itemFulfillment` path (which works). It then
 * calls this RESTlet to create the matching Item Receipt. This split
 * exists because the REST `!transform/itemReceipt` path is blocked in
 * our NS account configuration ("invalid reference") — SuiteScript's
 * record.transform() does not have that limitation.
 *
 * ─── Request body ────────────────────────────────────────────
 * {
 *   "transferOrderId": "523165",        // required, string id
 *   "destBinId":       "123",            // required, bin internal id
 *   "lines": [                           // required, 1+ entries
 *     { "orderLine": 48, "quantity": 1 },
 *     { "orderLine": 66, "quantity": 1 }
 *   ]
 * }
 *
 * `orderLine` values must match the TO's transactionline sequence
 * numbers for receive-side sub-rows. For each line the picker actually
 * fulfilled: orderLine = REST `l.line` + 2. The caller computes this
 * and passes it in — the RESTlet just uses what it receives.
 *
 * ─── Response ────────────────────────────────────────────────
 * On success (200):
 * {
 *   "status": "created",
 *   "receiptId": "530000",
 *   "transferOrderId": "523165"
 * }
 *
 * On error, SuiteScript returns a 500 with the thrown error message.
 * The caller should treat any non-200 as a receipt failure and mark
 * the session `fulfilled_pending_receipt`.
 */
define(['N/record', 'N/log'], function (record, log) {
  function doPost(body) {
    log.audit({ title: 'receiveTransferOrder.request', details: body });

    // ─── Validate inputs ───
    var toId = body && body.transferOrderId ? String(body.transferOrderId) : '';
    var destBinId = body && body.destBinId ? String(body.destBinId) : '';
    var lines = body && Array.isArray(body.lines) ? body.lines : [];

    if (!toId) { throw Error('transferOrderId is required'); }
    if (!destBinId) { throw Error('destBinId is required'); }
    if (lines.length === 0) { throw Error('lines[] must be non-empty'); }

    // Map orderLine → quantity so we can look up as we walk the receipt sublist
    var qtyByOrderLine = {};
    for (var li = 0; li < lines.length; li++) {
      var l = lines[li];
      var ol = String(l.orderLine);
      var qty = Number(l.quantity) || 0;
      if (qty > 0) { qtyByOrderLine[ol] = qty; }
    }

    // ─── Transform TO → IR ───
    // Dynamic mode so we can manipulate the inventoryDetail subrecord's
    // inventoryassignment sublist (select/commit pattern).
    var receipt = record.transform({
      fromType: record.Type.TRANSFER_ORDER,
      fromId: toId,
      toType: record.Type.ITEM_RECEIPT,
      isDynamic: true,
    });

    // ─── Walk the sublist ───
    // The pre-populated sublist contains one line per in-transit TO line.
    // For lines the picker fulfilled (matched by orderLine): set itemreceive=true,
    // set quantity, and override the inventoryDetail to land stock into the
    // configured destination bin.
    // For other lines: set itemreceive=false (skip this receipt).
    var lineCount = receipt.getLineCount({ sublistId: 'item' });
    log.audit({ title: 'receiveTransferOrder.sublistSize', details: lineCount });

    var touched = 0;
    for (var i = 0; i < lineCount; i++) {
      receipt.selectLine({ sublistId: 'item', line: i });
      var orderLine = receipt.getCurrentSublistValue({ sublistId: 'item', fieldId: 'orderline' });
      var qty = qtyByOrderLine[String(orderLine)];

      if (qty && qty > 0) {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });

        // Bin assignment lives in an inventoryDetail SUBRECORD per line.
        var invDetail = receipt.getCurrentSublistSubrecord({
          sublistId: 'item',
          fieldId: 'inventorydetail',
        });

        // Remove pre-populated assignments so NS uses only ours.
        var existingCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
        for (var j = existingCount - 1; j >= 0; j--) {
          invDetail.removeLine({ sublistId: 'inventoryassignment', line: j });
        }

        // Add our single assignment for the configured destination bin.
        invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
        invDetail.setCurrentSublistValue({
          sublistId: 'inventoryassignment',
          fieldId: 'binnumber',
          value: destBinId,
        });
        invDetail.setCurrentSublistValue({
          sublistId: 'inventoryassignment',
          fieldId: 'quantity',
          value: qty,
        });
        invDetail.commitLine({ sublistId: 'inventoryassignment' });

        touched++;
      } else {
        receipt.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
      }

      receipt.commitLine({ sublistId: 'item' });
    }

    if (touched === 0) {
      throw Error(
        'No receipt lines were matched. Passed orderLine values did not match any line in the ' +
        'transformed Item Receipt sublist. Expected one of: ' + Object.keys(qtyByOrderLine).join(', ')
      );
    }

    // ─── Save ───
    var receiptId = receipt.save({
      enableSourcing: true,
      ignoreMandatoryFields: false,
    });

    log.audit({
      title: 'receiveTransferOrder.created',
      details: { receiptId: receiptId, transferOrderId: toId, touched: touched },
    });

    return {
      status: 'created',
      receiptId: String(receiptId),
      transferOrderId: toId,
      linesReceived: touched,
    };
  }

  return {
    post: doPost,
  };
});
