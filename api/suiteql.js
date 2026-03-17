import { getConfig, generateOAuthHeader } from "./_auth.js";

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
