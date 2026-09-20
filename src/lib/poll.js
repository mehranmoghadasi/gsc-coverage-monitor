/**
 * poll.js — one monitoring pass for one property. Pure orchestration; every
 * external call goes through the injected `api` so it can be tested with fakes.
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.api        { queryDaily, queryPages, listSitemaps, inspectUrl, fetchSitemapUrls }
 * @param {object} deps.cfg        normalized config
 * @param {object} deps.property   one entry of cfg.properties
 * @param {string} deps.today      ISO date
 * @param {(msg:string)=>void} [deps.log]
 * @returns {Promise<{regressions: object[], inspected: number, pagesTracked: number}>}
 */
import { analyticsWindows } from './dates.js';
import { siteImpressionDrop, vanishedPages, inspectionTransition, sitemapIssues } from './detector.js';
import { pickInspectionSample, belongsToProperty } from './sampler.js';
import * as store from './db.js';

export async function pollProperty({ db, api, cfg, property, today, log = () => {} }) {
  const site = property.siteUrl;
  const w = analyticsWindows(cfg.analytics, today);
  const found = [];
  const record = (reg) => {
    if (store.insertRegression(db, site, today, reg)) found.push({ ...reg, siteUrl: site, detectedAt: today });
  };

  // 1. Search Analytics — daily totals (both windows in one call) + per-page windows
  const daily = await api.queryDaily(site, w.baselineStart, w.recentEnd);
  store.upsertSiteDaily(db, site, daily);
  const baselineRows = daily.filter((r) => r.date >= w.baselineStart && r.date <= w.baselineEnd);
  const recentRows = daily.filter((r) => r.date >= w.recentStart && r.date <= w.recentEnd);
  const siteDrop = siteImpressionDrop(baselineRows, recentRows, cfg.analytics);
  if (siteDrop) record(siteDrop);

  const basePages = await api.queryPages(site, w.baselineStart, w.baselineEnd);
  const recentPages = await api.queryPages(site, w.recentStart, w.recentEnd);
  store.replacePageWindow(db, site, w.baselineStart, w.baselineEnd, basePages);
  store.replacePageWindow(db, site, w.recentStart, w.recentEnd, recentPages);
  const vanished = vanishedPages(basePages, recentPages, cfg.analytics);
  for (const v of vanished) record(v);
  // Every page Google has shown is a URL worth tracking.
  store.addKnownUrls(db, site, basePages.map((p) => p.page), 'analytics', today);
  log(`  analytics: ${daily.length} days, ${basePages.length} pages in baseline, ${vanished.length} vanished`);

  // 2. Sitemaps — real fields only
  const sitemaps = await api.listSitemaps(site);
  for (const s of sitemaps) {
    const prev = store.previousSitemapSnapshot(db, site, s.path, today);
    store.upsertSitemapSnapshot(db, site, today, s);
    for (const issue of sitemapIssues(prev, s, cfg.sitemaps)) record(issue);
  }
  const sitemapUrls = [...new Set([...property.sitemaps, ...sitemaps.map((s) => s.path)])];
  let seeded = 0;
  for (const sm of sitemapUrls) {
    const urls = (await api.fetchSitemapUrls(sm)).filter((u) => belongsToProperty(u, site));
    seeded += store.addKnownUrls(db, site, urls, 'sitemap', today);
  }
  log(`  sitemaps: ${sitemaps.length} submitted, ${seeded} new URLs discovered`);

  // 3. URL Inspection — spend today's budget where it matters
  const olderThan = new Date(`${today}T00:00:00Z`);
  olderThan.setUTCDate(olderThan.getUTCDate() - cfg.inspection.recheckIntervalDays);
  const due = store.urlsDueForInspection(db, site, olderThan.toISOString(), cfg.inspection.dailyBudget);
  const sample = pickInspectionSample(vanished.map((v) => v.subject), due, cfg.inspection.dailyBudget).filter((u) => belongsToProperty(u, site));
  let inspected = 0;
  for (const url of sample) {
    let result;
    try {
      result = await api.inspectUrl(site, url);
    } catch (err) {
      log(`  inspect failed for ${url}: ${err.message}`);
      continue;
    }
    const checkedAt = new Date().toISOString();
    const prev = store.latestInspection(db, site, url);
    store.insertInspection(db, site, { ...result, checkedAt });
    store.markInspected(db, site, url, checkedAt);
    inspected++;
    const t = inspectionTransition(prev, result);
    if (t) record(t);
  }
  log(`  inspection: ${inspected}/${sample.length} URLs checked`);

  return { regressions: found, inspected, pagesTracked: store.knownUrlCount(db, site) };
}
