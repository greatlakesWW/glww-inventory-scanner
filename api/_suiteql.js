import { getConfig, generateOAuthHeader } from "./_auth.js";

// ═══════════════════════════════════════════════════════════
// Server-side SuiteQL helper
//
// Used by endpoints that need to call SuiteQL directly (vs. going
// through /api/suiteql from the client). Throws on non-2xx responses
// so callers can bubble up meaningful errors — unlike the trimmed-down
// helper in adjust.js which silently returns [] for best-effort lookups.
// ═══════════════════════════════════════════════════════════

/**
 * @typedef {Object} SuiteQLResult
 * @property {any[]} items
 * @property {number} totalResults
 * @property {number} count
 * @property {boolean} hasMore
 */

/**
 * Execute a SuiteQL query against NetSuite via signed OAuth 1.0a request.
 * Throws Error on missing credentials or non-2xx response.
 *
 * @param {string} query - SuiteQL statement
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<SuiteQLResult>}
 */
export async function runSuiteQL(query, opts = {}) {
  if (!query || typeof query !== "string") {
    throw new Error("runSuiteQL: 'query' must be a non-empty string");
  }
  const limit = Number.isFinite(opts.limit) ? opts.limit : 1000;
  const offset = Number.isFinite(opts.offset) ? opts.offset : 0;

  const config = getSuiteQLConfig(); // throws if creds missing

  const baseUrl = `https://${config.accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const queryParams = { limit: String(limit), offset: String(offset) };
  const fullUrl = `${baseUrl}?limit=${limit}&offset=${offset}`;
  const authHeader = generateOAuthHeader("POST", baseUrl, queryParams, config);

  const resp = await fetch(fullUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Prefer: "transient",
    },
    body: JSON.stringify({ q: query }),
  });

  const text = await resp.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!resp.ok) {
    const detail = typeof data === "object" && data !== null ? JSON.stringify(data) : String(data || "");
    const err = new Error(`SuiteQL ${resp.status}: ${detail.slice(0, 500)}`);
    err.status = resp.status;
    err.body = data;
    throw err;
  }

  return {
    items: (data && data.items) || [],
    totalResults: (data && data.totalResults) || 0,
    count: (data && data.count) || 0,
    hasMore: (data && data.hasMore) || false,
  };
}

/**
 * Returns the NetSuite TBA config, or throws if any credential is missing.
 * Centralizes the 5-field presence check so every endpoint doesn't duplicate it.
 *
 * @returns {ReturnType<typeof getConfig>}
 */
export function getSuiteQLConfig() {
  const config = getConfig();
  if (!config.accountId || !config.consumerKey || !config.consumerSecret || !config.tokenId || !config.tokenSecret) {
    const err = new Error(
      "Missing NetSuite credentials. Set NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET in Vercel environment variables."
    );
    err.status = 500;
    throw err;
  }
  return config;
}

/**
 * Split an array of IDs into batches of at most `max` so IN (...) clauses
 * don't exceed NetSuite's expression-length limits. Used by callers that
 * need to query inventorybalance etc. for large sets of item IDs.
 *
 * @param {(string|number)[]} ids
 * @param {number} [max=200]
 * @returns {(string|number)[][]}
 */
export function batchIds(ids, max = 200) {
  const batches = [];
  for (let i = 0; i < ids.length; i += max) batches.push(ids.slice(i, i + max));
  return batches;
}
