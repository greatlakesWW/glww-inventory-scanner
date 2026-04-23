# NetSuite RESTlet deployment

This folder holds SuiteScript 2.x RESTlets the picker app calls when the REST Record API can't do the job. Deploying one is a ~5-minute one-time operation per RESTlet.

## Why this exists

Transfer Order receipts can't be created through the standard REST Record API in our account — every transform path (`transferOrder/{id}/!transform/itemReceipt`, `itemFulfillment/{id}/!transform/itemReceipt`, direct `/itemreceipt` POST) returns either "transformation not allowed" or "invalid reference." SuiteScript's `N/record` module has exactly **one** working path: `record.transform(TRANSFER_ORDER → ITEM_RECEIPT)`. We proved this via a 15-probe diagnostic matrix (commit 586bab4 → bdc0c1f) that tested every transform direction and every `record.create` defaultValues shape. Everything else is hard-blocked at the account level; features `ADVANCEDRECEIVING` and `INBOUNDSHIPMENT` are **not** the gate (both off, irrelevant).

Precondition for the working path: the source IF must be `shipStatus=C` (Shipped) so the TO enters "Pending Receipt" status. `api/transfer-orders/[id]/fulfill.js` PATCHes shipStatus before calling this RESTlet; if that PATCH fails, the RESTlet throws `INVALID_INITIALIZE_REF`.

## Files

| File | Purpose |
|---|---|
| `receiveTransferOrder.js` | Creates an Item Receipt against a TO. Called by `api/transfer-orders/[id]/fulfill.js` after the Item Fulfillment succeeds. |

---

## Deploying `receiveTransferOrder.js`

### Step 1 — Upload the file to the File Cabinet

1. In NetSuite, go to **Documents → Files → File Cabinet**
2. Navigate to `SuiteScripts` (create if missing)
3. Click **Add File**, upload `receiveTransferOrder.js`
4. Note the file's internal ID from the URL after upload

### Step 2 — Create the Script record

1. Go to **Customization → Scripting → Scripts → New**
2. Click the **Select** button and pick the file you just uploaded
3. Click **Create Script Record**
4. On the Script record form:
   - **Name:** `Pick Mode - Receive Transfer Order`
   - **ID:** `_pickmode_receive_transfer_order` (auto-generated or set explicit)
   - **Type:** already set to "RESTlet" (inferred from the file)
   - Save

### Step 3 — Create the Script Deployment

1. On the Script record, go to **Deployments** tab → **New Deployment** (or the form will prompt)
2. On the Deployment form:
   - **Title:** `Pick Mode - Receive Transfer Order Deployment`
   - **ID:** `_pickmode_receive_transfer_order_dep` (or auto)
   - **Status:** `Released`
   - **Log Level:** `Audit` (to see the RESTlet's own audit logs)
   - **Audience → Roles:** add the role used by the OAuth TBA token the picker app uses (same role as the existing SuiteQL/Record integration). Without this the RESTlet will 403.
   - Save

### Step 4 — Copy the RESTlet URL

After saving the Deployment, NetSuite shows a field called **External URL**. It looks like:

```
https://9405258.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1234&deploy=1
```

Copy the entire URL.

### Step 5 — Set the env var on Vercel

Vercel Dashboard → Project → Settings → Environment Variables → Add:

| Name | Value |
|---|---|
| `NS_RESTLET_RECEIVE_TO_URL` | the External URL from Step 4 |

Hit **Save**. Then **redeploy** the project (or push an empty commit) so the new env var lands in the serverless runtime.

---

## Testing the deployment

Once the env var is set and the deploy is green, you can do a quick sanity test via the existing `/api/record` proxy. (The RESTlet is at a different host than the standard REST API, so this just verifies auth works — the real use is from `fulfill.js`.)

Or simpler: complete a pick end-to-end in the app. If the RESTlet is wired correctly you'll see the green "TO complete" card with both an IF and IR id. If it isn't, the app shows the amber "Receipt pending" stuck card and the Vercel function logs will include either "`NS_RESTLET_RECEIVE_TO_URL not set`" or the RESTlet's response body.

## Updating the RESTlet later

If the logic needs to change:
1. Edit `receiveTransferOrder.js` in this repo
2. In NS, go to the **File Cabinet** entry for the file
3. Click **Edit** → **Upload** and select the updated file → Save

No new deployment needed; the updated file is picked up on the next invocation. Keep the repo and the File Cabinet in sync so the committed code is the source of truth.

## Role permissions

The role the TBA token uses must include:
- **Lists → Bins** (already added for earlier work)
- **Transactions → Transfer Order** (view, to load the source)
- **Transactions → Item Receipt** (create + edit, to save the new receipt)
- **Setup → Run SuiteScript** (to execute the RESTlet at all)
- Access to the Deployment itself (configured in Step 3 above)

If you get `INSUFFICIENT_PERMISSION` when calling the RESTlet, that's the first place to check.
