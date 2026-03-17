import crypto from "crypto";

// ─── NetSuite TBA credentials from Vercel environment variables ───
export const getConfig = () => ({
  accountId: process.env.NS_ACCOUNT_ID,
  consumerKey: process.env.NS_CONSUMER_KEY,
  consumerSecret: process.env.NS_CONSUMER_SECRET,
  tokenId: process.env.NS_TOKEN_ID,
  tokenSecret: process.env.NS_TOKEN_SECRET,
});

// ─── RFC 3986 encoding ───
export function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// ─── OAuth 1.0 Signature (HMAC-SHA256) ───
export function generateOAuthHeader(method, baseUrl, queryParams, config) {
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
