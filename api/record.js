import { getConfig, generateOAuthHeader } from "./_auth.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

export default async function handler(req, res) {
  // ─── CORS ───
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only — use the 'method' field in the request body to specify the HTTP verb for NetSuite." });

  // ─── Credentials ───
  const config = getConfig();
  if (!config.accountId || !config.consumerKey || !config.consumerSecret || !config.tokenId || !config.tokenSecret) {
    return res.status(500).json({
      error: "Missing NetSuite credentials. Set NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET in Vercel environment variables.",
    });
  }

  // ─── Parse & validate request body ───
  const { method, path, body } = req.body;

  if (!method || !ALLOWED_METHODS.has(method.toUpperCase())) {
    return res.status(400).json({
      error: `Invalid or missing 'method'. Must be one of: ${[...ALLOWED_METHODS].join(", ")}`,
    });
  }

  if (!path) {
    return res.status(400).json({ error: "Missing 'path' in request body." });
  }

  const upperMethod = method.toUpperCase();

  if ((upperMethod === "POST" || upperMethod === "PATCH") && !body) {
    return res.status(400).json({
      error: `'body' is required for ${upperMethod} requests.`,
    });
  }

  // ─── Build NetSuite URL ───
  // Separate path from query string (if any)
  const [cleanPath, queryString] = path.split("?");
  const queryParams = {};
  if (queryString) {
    for (const pair of queryString.split("&")) {
      const [key, ...rest] = pair.split("=");
      if (key) queryParams[decodeURIComponent(key)] = decodeURIComponent(rest.join("="));
    }
  }

  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/${cleanPath}`;
  const fullUrl = queryString ? `${baseUrl}?${queryString}` : baseUrl;

  // ─── OAuth header uses the ACTUAL HTTP method ───
  const authHeader = generateOAuthHeader(upperMethod, baseUrl, queryParams, config);

  // ─── Forward to NetSuite ───
  const fetchOptions = {
    method: upperMethod,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
  };

  if ((upperMethod === "POST" || upperMethod === "PATCH") && body) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const nsResponse = await fetch(fullUrl, fetchOptions);

    // Read response body (may be empty for 204)
    const responseText = await nsResponse.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }

    // Forward the Location header if present (contains new record URL)
    const locationHeader = nsResponse.headers.get("Location");

    const result = {
      status: nsResponse.status,
      ...(locationHeader && { location: locationHeader }),
      ...(responseBody !== null && { data: responseBody }),
    };

    return res.status(nsResponse.status).json(result);
  } catch (err) {
    console.error("Record proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
}
