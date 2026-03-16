import crypto from "crypto";

const getConfig = () => ({
  accountId: process.env.NS_ACCOUNT_ID,
  consumerKey: process.env.NS_CONSUMER_KEY,
  consumerSecret: process.env.NS_CONSUMER_SECRET,
  tokenId: process.env.NS_TOKEN_ID,
  tokenSecret: process.env.NS_TOKEN_SECRET,
});

function generateOAuthHeader(method, baseUrl, queryParams, config) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const oauthParams = {
    oauth_consumer_key: config.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: timestamp,
    oauth_token: config.tokenId,
    oauth_version: "1.0",
  };
  const allParams = { ...oauthParams, ...queryParams };
  const sortedParams = Object.keys(allParams).sort().map(k => `${enc(k)}=${enc(String(allParams[k]))}`).join("&");
  const baseString = `${method.toUpperCase()}&${enc(baseUrl)}&${enc(sortedParams)}`;
  const signingKey = `${enc(config.consumerSecret)}&${enc(config.tokenSecret)}`;
  const signature = crypto.createHmac("sha256", signingKey).update(baseString).digest("base64");
  const headerParams = { realm: config.accountId, ...oauthParams, oauth_signature: signature };
  return "OAuth " + Object.keys(headerParams).map(k => `${k}="${enc(headerParams[k])}"`).join(", ");
}

function enc(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Helper to run SuiteQL and get IDs
async function runSuiteQL(config, query) {
  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const qp = { limit: "10", offset: "0" };
  const authHeader = generateOAuthHeader("POST", baseUrl, qp, config);
  const resp = await fetch(`${baseUrl}?limit=10&offset=0`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json", Prefer: "transient" },
    body: JSON.stringify({ q: query }),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.items || [];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const config = getConfig();
  if (!config.accountId || !config.consumerKey || !config.consumerSecret || !config.tokenId || !config.tokenSecret) {
    return res.status(500).json({ error: "Missing NetSuite credentials." });
  }

  const { locationId, locationName, items, memo } = req.body;

  if (!locationId || !items || items.length === 0) {
    return res.status(400).json({ error: "Missing locationId or items" });
  }

  try {
    // Hardcoded GLWW IDs
    const subsidiaryId = "2";    // Great Lakes Work Wear
    const accountIdVal = "452";  // 60050 Inventory Adjustment

    // Step 2: Build the inventory adjustment payload with internal IDs
    const adjustmentBody = {
      subsidiary: { id: String(subsidiaryId) },
      account: { id: String(accountIdVal) },
      adjLocation: { id: String(locationId) },
      memo: memo || `Inventory Count - ${locationName || "Unknown"} - ${new Date().toISOString().slice(0, 10)}`,
      inventory: {
        items: items.map((item, idx) => {
          const line = {
            item: { id: String(item.internalid) },
            adjustQtyBy: Number(item.diff),
            location: { id: String(locationId) },
            line: idx + 1,
          };

          if (item.bin_id) {
            line.inventoryDetail = {
              inventoryAssignment: {
                items: [{
                  binNumber: { id: String(item.bin_id) },
                  quantity: Number(item.diff),
                }],
              },
            };
          }

          return line;
        }),
      },
    };

    console.log("Submitting adjustment:", JSON.stringify(adjustmentBody).slice(0, 500));

    // Step 3: Create the inventory adjustment
    const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/inventoryadjustment`;
    const authHeader = generateOAuthHeader("POST", baseUrl, {}, config);

    const nsResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(adjustmentBody),
    });

    // Read response body first
    let responseBody = null;
    const responseText = await nsResponse.text();
    try { responseBody = JSON.parse(responseText); } catch (e) { responseBody = responseText; }

    const locationHeader = nsResponse.headers.get("Location") || "";
    const idMatch = locationHeader.match(/\/(\d+)$/);
    const recordId = idMatch ? idMatch[1] : null;

    console.log("NetSuite response:", nsResponse.status, "Location:", locationHeader, "Body:", responseText.slice(0, 500));

    // Handle success statuses
    if (nsResponse.status === 204 || nsResponse.status === 201 || nsResponse.status === 200) {
      const recordUrl = recordId
        ? `https://${config.accountId}.app.netsuite.com/app/accounting/transactions/invadjst.nl?id=${recordId}`
        : null;
      return res.status(200).json({
        success: true, recordId, recordUrl,
        message: `Inventory adjustment created${recordId ? ` (ID: ${recordId})` : ""}.`,
      });
    }

    if (nsResponse.status === 202) {
      // Async — return whatever info we have plus the response body
      return res.status(200).json({
        success: false,
        error: `NetSuite returned 202 (async). The adjustment may not have been created.`,
        details: responseBody,
      });
    }

    // Handle errors
    console.error("NetSuite adjust error:", nsResponse.status, responseText);

    return res.status(nsResponse.status || 500).json({
      success: false,
      error: `NetSuite returned ${nsResponse.status}`,
      details: responseBody,
    });
  } catch (err) {
    console.error("Adjustment API error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
