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
 *   "fulfillmentId":   "526977",        // required, string id of the IF
 *   "transferOrderId": "523165",        // informational, audited in logs
 *   "destBinId":       "123",            // required, bin internal id
 *   "lines": [                           // required, 1+ entries
 *     { "orderLine": 48, "quantity": 1 },
 *     { "orderLine": 66, "quantity": 1 }
 *   ]
 * }
 *
 * The receipt is transformed from the Item Fulfillment (not the
 * source TO). SuiteScript's TRANSFER_ORDER → ITEM_RECEIPT transform
 * is rejected with INVALID_INITIALIZE_REF; ITEM_FULFILLMENT →
 * ITEM_RECEIPT works as intended.
 *
 * `orderLine` values should match each picked line in the IF's item
 * sublist (IF's own `line` field). The caller (fulfill.js) knows these
 * from its POST response; retry-receipt.js reconstructs them from REST
 * `l.line + 2` (receive-side sub-row per NS's 3-rows-per-item layout).
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
    var fulfillmentId = body && body.fulfillmentId ? String(body.fulfillmentId) : '';
    var toId = body && body.transferOrderId ? String(body.transferOrderId) : '';
    var destBinId = body && body.destBinId ? String(body.destBinId) : '';
    var lines = body && Array.isArray(body.lines) ? body.lines : [];

    if (!fulfillmentId) { throw Error('fulfillmentId is required'); }
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

    // ─── Create IR with createdfrom set ───
    // This account's config blocks record.transform() for both
    // TRANSFER_ORDER → ITEM_RECEIPT (INVALID_INITIALIZE_REF) and
    // ITEM_FULFILLMENT → ITEM_RECEIPT (INVALID_RCRD_TRANSFRM).
    //
    // Workaround: create a blank ITEM_RECEIPT with defaultValues
    // pointing at the source document. NetSuite will auto-source the
    // line sublist from that source. Try several key names because the
    // exact default key for TO receipts is undocumented — we log which
    // one worked so future maintainers know.
    var receipt = null;
    var lastCreateError = null;
    var attemptKeys = [
      { transaction: fulfillmentId },
      { order: fulfillmentId },
      { createdfrom: fulfillmentId },
      { transaction: toId },
      { order: toId },
      { createdfrom: toId },
    ];
    for (var k = 0; k < attemptKeys.length; k++) {
      try {
        receipt = record.create({
          type: record.Type.ITEM_RECEIPT,
          isDynamic: true,
          defaultValues: attemptKeys[k],
        });
        log.audit({ title: 'receiveTransferOrder.createWorked', details: attemptKeys[k] });
        break;
      } catch (err) {
        lastCreateError = err;
        log.debug({ title: 'receiveTransferOrder.createAttemptFailed', details: { tried: attemptKeys[k], msg: err.message } });
      }
    }
    if (!receipt) {
      throw Error('All record.create attempts for ITEM_RECEIPT failed. Last error: ' + (lastCreateError && lastCreateError.message));
    }

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
