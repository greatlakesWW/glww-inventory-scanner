import crypto from "crypto";

// ─── NetSuite TBA credentials from Vercel environment variables ───
const getConfig = () => ({
  accountId: process.env.NS_ACCOUNT_ID,
  consumerKey: process.env.NS_CONSUMER_KEY,
  consumerSecret: process.env.NS_CONSUMER_SECRET,
  tokenId: process.env.NS_TOKEN_ID,
  tokenSecret: process.env.NS_TOKEN_SECRET,
});

// ─── OAuth 1.0 Signature (HMAC-SHA256) ───
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

  // Merge OAuth params + query params for signature base string
  const allParams = { ...oauthParams, ...queryParams };

  const sortedParams = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(String(allParams[k]))}`)
    .join("&");

  const baseString = `${method.toUpperCase()}&${encodeRFC3986(baseUrl)}&${encodeRFC3986(sortedParams)}`;

  // Sign
  const signingKey = `${encodeRFC3986(config.consumerSecret)}&${encodeRFC3986(config.tokenSecret)}`;
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(baseString)
    .digest("base64");

  // Build header — only OAuth params + realm + signature (NOT query params)
  const headerParams = {
    realm: config.accountId,
    ...oauthParams,
    oauth_signature: signature,
  };

  const header =
    "OAuth " +
    Object.keys(headerParams)
      .map((k) => `${k}="${encodeRFC3986(headerParams[k])}"`)
      .join(", ");

  return header;
}

function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// ─── Handler ───
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const config = getConfig();

  // Validate config
  if (!config.accountId || !config.consumerKey || !config.consumerSecret || !config.tokenId || !config.tokenSecret) {
    return res.status(500).json({
      error: "Missing NetSuite credentials. Set NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET in Vercel environment variables.",
    });
  }

  const { query, limit = 1000, offset = 0 } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Missing 'query' in request body" });
  }

  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const queryParams = { limit: String(limit), offset: String(offset) };
  const fullUrl = `${baseUrl}?limit=${limit}&offset=${offset}`;

  const authHeader = generateOAuthHeader("POST", baseUrl, queryParams, config);

  try {
    const nsResponse = await fetch(fullUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Prefer: "transient",
      },
      body: JSON.stringify({ q: query }),
    });

    if (!nsResponse.ok) {
      const errorBody = await nsResponse.text();
      console.error("NetSuite error:", nsResponse.status, errorBody);
      return res.status(nsResponse.status).json({
        error: `NetSuite returned ${nsResponse.status}`,
        details: errorBody,
      });
    }

    const data = await nsResponse.json();
    return res.status(200).json({
      items: data.items || [],
      totalResults: data.totalResults || 0,
      count: data.count || 0,
      hasMore: data.hasMore || false,
    });
  } catch (err) {
    console.error("SuiteQL proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
}
