/**
 * gsc.js — Google Search Console API wrapper
 *
 * Provides functions to:
 *   - List sitemaps for a property and extract URL counts
 *   - Fetch coverage category counts (valid, errors, warnings, excluded)
 *   - Handle pagination and rate-limit retries automatically
 *
 * The Search Console API has strict quota limits (1 QPS per project).
 * This module enforces a 1.1-second minimum delay between requests.
 */

import { google } from 'googleapis';

const REQUEST_DELAY_MS = 1100; // stay within 1 QPS quota
const MAX_RETRIES = 3;

/**
 * @typedef {Object} CoverageSnapshot
 * @property {string} siteUrl           - The GSC property URL
 * @property {string} date              - ISO date string (YYYY-MM-DD)
 * @property {number} submittedUrls     - Total URLs in submitted sitemaps
 * @property {number} indexedUrls       - Google-reported indexed URL count
 * @property {number} errorUrls         - URL count with coverage errors
 * @property {number} warningUrls       - URL count with coverage warnings
 * @property {number} excludedUrls      - URL count excluded from indexing
 * @property {number} sitemapCount      - Number of sitemaps found
 */

/**
 * Fetch a coverage snapshot for a single GSC property.
 *
 * @param {object} auth           - Authenticated Google auth client
 * @param {string} siteUrl        - GSC property URL
 * @returns {Promise<CoverageSnapshot>}
 */
export async function fetchCoverageSnapshot(auth, siteUrl) {
  const sc = google.webmasters({ version: 'v3', auth });

  const sitemaps = await withRetry(() => sc.sitemaps.list({ siteUrl }));
  const sitemapList = sitemaps.data.sitemap ?? [];

  let submittedUrls = 0;
  let indexedUrls = 0;
  let errorUrls = 0;
  let warningUrls = 0;
  let excludedUrls = 0;

  for (const sitemap of sitemapList) {
    await sleep(REQUEST_DELAY_MS);

    submittedUrls += getContentsCount(sitemap, 'WEB');
    indexedUrls += getIndexedCount(sitemap);

    // Accumulate error/warning/excluded from sitemap contents metadata
    for (const content of sitemap.contents ?? []) {
      if (content.type !== 'WEB') continue;
      errorUrls += Number(content.errorsCount ?? 0);
      warningUrls += Number(content.warningsCount ?? 0);
    }
  }

  // Excluded = submitted - (indexed + errors + warnings), floor at 0
  excludedUrls = Math.max(0, submittedUrls - indexedUrls - errorUrls - warningUrls);

  const date = new Date().toISOString().slice(0, 10);

  return {
    siteUrl,
    date,
    submittedUrls,
    indexedUrls,
    errorUrls,
    warningUrls,
    excludedUrls,
    sitemapCount: sitemapList.length,
  };
}

/**
 * Fetch snapshots for all properties in sequence (rate-limit safe).
 *
 * @param {object} auth
 * @param {string[]} siteUrls
 * @returns {Promise<CoverageSnapshot[]>}
 */
export async function fetchAllSnapshots(auth, siteUrls) {
  const results = [];
  for (const siteUrl of siteUrls) {
    await sleep(REQUEST_DELAY_MS);
    try {
      const snapshot = await fetchCoverageSnapshot(auth, siteUrl);
      results.push(snapshot);
    } catch (err) {
      console.error(`[gsc] Failed to fetch ${siteUrl}: ${err.message}`);
      results.push({
        siteUrl,
        date: new Date().toISOString().slice(0, 10),
        submittedUrls: -1,
        indexedUrls: -1,
        errorUrls: -1,
        warningUrls: -1,
        excludedUrls: -1,
        sitemapCount: 0,
        error: err.message,
      });
    }
  }
  return results;
}

/**
 * List all GSC properties the authenticated account has access to.
 *
 * @param {object} auth
 * @returns {Promise<string[]>} - Array of site URLs
 */
export async function listAccessibleProperties(auth) {
  const sc = google.webmasters({ version: 'v3', auth });
  const res = await withRetry(() => sc.sites.list());
  return (res.data.siteEntry ?? []).map((s) => s.siteUrl);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract submitted URL count for WEB type from sitemap entry.
 *
 * @param {object} sitemap - Sitemap resource object from API
 * @param {string} type    - Content type to filter ('WEB', 'IMAGE', etc.)
 * @returns {number}
 */
function getContentsCount(sitemap, type) {
  return (sitemap.contents ?? [])
    .filter((c) => c.type === type)
    .reduce((sum, c) => sum + Number(c.submitted ?? 0), 0);
}

/**
 * Extract indexed URL count from a sitemap entry.
 *
 * @param {object} sitemap
 * @returns {number}
 */
function getIndexedCount(sitemap) {
  return (sitemap.contents ?? [])
    .filter((c) => c.type === 'WEB')
    .reduce((sum, c) => sum + Number(c.indexed ?? 0), 0);
}

/**
 * Execute an API call with exponential-backoff retry on transient errors.
 *
 * @param {Function} fn         - Async function to retry
 * @param {number}   [attempt]  - Internal recursion counter
 * @returns {Promise<any>}
 */
async function withRetry(fn, attempt = 0) {
  try {
    return await fn();
  } catch (err) {
    const isTransient = err.code === 429 || err.code === 500 || err.code === 503;
    if (isTransient && attempt < MAX_RETRIES) {
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await sleep(delay);
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
