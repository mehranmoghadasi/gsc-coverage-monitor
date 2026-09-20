/**
 * gsc.js — the only module that talks to Google.
 *
 * Endpoints used (all current, all documented):
 *   webmasters v3  searchanalytics.query   — clicks/impressions by date and by page
 *   webmasters v3  sitemaps.list           — submitted count, errors, warnings, isPending
 *   searchconsole v1 urlInspection.index.inspect — verdict, coverageState, canonicals
 *
 * NOT used: sitemap.contents[].indexed — Google marks it deprecated and it returns
 * nothing. v1 of this tool was built on it, which is why v1 never alerted.
 */
import { google } from 'googleapis';

const QPS_DELAY_MS = 1100;
const MAX_RETRIES = 4;
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

export async function createAuth(credentialsPath) {
  if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
  const auth = new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: SCOPES });
  return auth.getClient();
}

export function createClients(auth) {
  return { webmasters: google.webmasters({ version: 'v3', auth }), searchconsole: google.searchconsole({ version: 'v1', auth }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      await sleep(QPS_DELAY_MS);
      return await fn();
    } catch (err) {
      const code = err?.code ?? err?.response?.status;
      const retryable = code === 429 || code === 403 || (code >= 500 && code < 600) || err?.code === 'ECONNRESET';
      if (!retryable || attempt >= MAX_RETRIES) {
        err.message = `${label}: ${err.message}`;
        throw err;
      }
      await sleep(delay);
      delay *= 2;
    }
  }
}

/** Daily site totals for a date range. */
export async function queryDaily(clients, siteUrl, startDate, endDate) {
  const res = await withRetry(() => clients.webmasters.searchanalytics.query({
    siteUrl,
    requestBody: { startDate, endDate, dimensions: ['date'], rowLimit: 1000, dataState: 'final' },
  }), 'searchanalytics.query(date)');
  return (res.data.rows ?? []).map((r) => ({ date: r.keys[0], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 }));
}

/** Per-page totals over a window, paginated to the API's 25,000-row max. */
export async function queryPages(clients, siteUrl, startDate, endDate, maxRows = 100000) {
  const rows = [];
  for (let startRow = 0; startRow < maxRows; startRow += 25000) {
    const res = await withRetry(() => clients.webmasters.searchanalytics.query({
      siteUrl,
      requestBody: { startDate, endDate, dimensions: ['page'], rowLimit: 25000, startRow, dataState: 'final' },
    }), 'searchanalytics.query(page)');
    const batch = res.data.rows ?? [];
    for (const r of batch) rows.push({ page: r.keys[0], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 });
    if (batch.length < 25000) break;
  }
  return rows;
}

/** Sitemap list with the fields that really exist on the Sitemap resource. */
export async function listSitemaps(clients, siteUrl) {
  const res = await withRetry(() => clients.webmasters.sitemaps.list({ siteUrl }), 'sitemaps.list');
  return (res.data.sitemap ?? []).map((s) => ({
    path: s.path,
    submitted: (s.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0),
    errors: Number(s.errors ?? 0),
    warnings: Number(s.warnings ?? 0),
    isPending: !!s.isPending,
    lastDownloaded: s.lastDownloaded ?? null,
  }));
}

/** URL Inspection — 2,000 calls/day/property; caller enforces the budget. */
export async function inspectUrl(clients, siteUrl, inspectionUrl) {
  const res = await withRetry(() => clients.searchconsole.urlInspection.index.inspect({
    requestBody: { siteUrl, inspectionUrl },
  }), 'urlInspection.inspect');
  const r = res.data.inspectionResult?.indexStatusResult ?? {};
  return {
    url: inspectionUrl,
    verdict: r.verdict ?? 'VERDICT_UNSPECIFIED',
    coverageState: r.coverageState ?? '',
    indexingState: r.indexingState ?? '',
    robotsTxtState: r.robotsTxtState ?? '',
    lastCrawlTime: r.lastCrawlTime ?? null,
    googleCanonical: r.googleCanonical ?? null,
    userCanonical: r.userCanonical ?? null,
    inspectionResultLink: res.data.inspectionResult?.inspectionResultLink ?? null,
  };
}
