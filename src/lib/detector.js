/**
 * detector.js — pure regression logic. No I/O, fully unit-tested.
 *
 * Three independent signals, each grounded in a GSC endpoint that really
 * returns data:
 *   1. Search Analytics (site level)  → impression collapse
 *   2. Search Analytics (page level)  → pages that vanished from search
 *   3. URL Inspection                 → index-state flips (indexed → not)
 *   4. Sitemaps                       → submitted-count drops, new errors
 */

/**
 * @typedef {{date:string, clicks:number, impressions:number}} DailyRow
 * @typedef {{page:string, clicks:number, impressions:number}} PageRow
 * @typedef {{type:string, subject:string, baseline:number, current:number, dropPct:number, severity:'high'|'medium'|'low', details:object}} Regression
 */

function pct(base, cur) {
  if (base <= 0) return 0;
  return Math.round(((base - cur) / base) * 1000) / 10;
}

/**
 * Site-level impression drift: average daily impressions in the recent window vs baseline.
 * @param {DailyRow[]} baselineRows
 * @param {DailyRow[]} recentRows
 * @param {{siteDropThresholdPct:number}} cfg
 * @returns {Regression|null}
 */
export function siteImpressionDrop(baselineRows, recentRows, cfg) {
  if (!baselineRows.length || !recentRows.length) return null;
  const avg = (rows) => rows.reduce((s, r) => s + r.impressions, 0) / rows.length;
  const base = avg(baselineRows);
  const cur = avg(recentRows);
  if (base < 10) return null; // too little traffic for a ratio to mean anything
  const drop = pct(base, cur);
  if (drop < cfg.siteDropThresholdPct) return null;
  return {
    type: 'site_impressions_drop',
    subject: 'site',
    baseline: Math.round(base),
    current: Math.round(cur),
    dropPct: drop,
    severity: drop >= 50 ? 'high' : 'medium',
    details: { baselineDays: baselineRows.length, recentDays: recentRows.length },
  };
}

/**
 * Pages that had steady impressions in the baseline window and none (or almost none) recently.
 * These are the pages most likely to have been de-indexed, redirected, or blocked.
 * @param {PageRow[]} baselinePages  aggregated over the baseline window
 * @param {PageRow[]} recentPages    aggregated over the recent window
 * @param {{pageMinBaselineImpressions:number, baselineDays:number, recentDays:number}} cfg
 * @returns {Regression[]}
 */
export function vanishedPages(baselinePages, recentPages, cfg) {
  const recent = new Map(recentPages.map((r) => [r.page, r]));
  const out = [];
  for (const b of baselinePages) {
    if (b.impressions < cfg.pageMinBaselineImpressions) continue;
    const r = recent.get(b.page);
    // Normalise both windows to impressions/day so unequal window lengths compare fairly.
    const basePerDay = b.impressions / cfg.baselineDays;
    const curPerDay = (r?.impressions ?? 0) / cfg.recentDays;
    const drop = pct(basePerDay, curPerDay);
    if (drop < 90) continue;
    out.push({
      type: 'page_vanished',
      subject: b.page,
      baseline: Math.round(basePerDay * 10) / 10,
      current: Math.round(curPerDay * 10) / 10,
      dropPct: drop,
      severity: b.clicks > 0 ? 'high' : 'medium',
      details: { baselineClicks: b.clicks, baselineImpressions: b.impressions, recentImpressions: r?.impressions ?? 0 },
    });
  }
  return out.sort((a, b) => b.details.baselineImpressions - a.details.baselineImpressions);
}

/** Map a URL Inspection result to a coarse bucket we can diff over time. */
export function indexBucket(inspection) {
  const verdict = inspection?.verdict ?? 'VERDICT_UNSPECIFIED';
  const state = inspection?.coverageState ?? '';
  if (verdict === 'PASS') return 'indexed';
  if (/^discovered/i.test(state)) return 'pending'; // "Discovered - currently not indexed": never crawled yet
  if (/not indexed|excluded|noindex|blocked|redirect|soft 404|404|error|duplicate|alternate/i.test(state) || verdict === 'FAIL') return 'not_indexed';
  return 'unknown';
}

/**
 * Compare the previous and current inspection of the same URL.
 * @param {object|null} prev  row from the inspections table (may be null)
 * @param {object} curr       fresh inspection
 * @returns {Regression|null}
 */
export function inspectionTransition(prev, curr) {
  const before = prev ? indexBucket(prev) : null;
  const after = indexBucket(curr);
  if (before === 'indexed' && after === 'not_indexed') {
    return {
      type: 'index_lost',
      subject: curr.url,
      baseline: 1,
      current: 0,
      dropPct: 100,
      severity: 'high',
      details: { from: prev.coverageState, to: curr.coverageState, robots: curr.robotsTxtState, lastCrawl: curr.lastCrawlTime },
    };
  }
  if (after === 'not_indexed' && curr.userCanonical && curr.googleCanonical && curr.userCanonical !== curr.googleCanonical) {
    return {
      type: 'canonical_mismatch',
      subject: curr.url,
      baseline: 0,
      current: 0,
      dropPct: 0,
      severity: 'medium',
      details: { userCanonical: curr.userCanonical, googleCanonical: curr.googleCanonical, state: curr.coverageState },
    };
  }
  if (after === 'not_indexed' && /blocked by robots/i.test(curr.coverageState ?? '') && before !== 'not_indexed') {
    return {
      type: 'robots_blocked',
      subject: curr.url,
      baseline: 0,
      current: 0,
      dropPct: 0,
      severity: 'high',
      details: { state: curr.coverageState, robots: curr.robotsTxtState },
    };
  }
  return null;
}

/**
 * Sitemap-level problems: submitted count fell sharply, sitemap now errors, or it stopped being fetched.
 * @param {object|null} prev previous snapshot row for this sitemap path
 * @param {object} curr current snapshot
 * @param {{submittedDropThresholdPct:number}} cfg
 * @returns {Regression[]}
 */
export function sitemapIssues(prev, curr, cfg) {
  const out = [];
  if (prev && prev.submitted > 0) {
    const drop = pct(prev.submitted, curr.submitted);
    if (drop >= cfg.submittedDropThresholdPct) {
      out.push({ type: 'sitemap_shrank', subject: curr.path, baseline: prev.submitted, current: curr.submitted, dropPct: drop, severity: drop >= 50 ? 'high' : 'medium', details: {} });
    }
  }
  if (curr.errors > 0 && (!prev || curr.errors > prev.errors)) {
    out.push({ type: 'sitemap_errors', subject: curr.path, baseline: prev?.errors ?? 0, current: curr.errors, dropPct: 0, severity: 'medium', details: { warnings: curr.warnings } });
  }
  if (curr.isPending && prev && !prev.isPending) {
    out.push({ type: 'sitemap_pending', subject: curr.path, baseline: 0, current: 0, dropPct: 0, severity: 'low', details: { lastDownloaded: curr.lastDownloaded } });
  }
  return out;
}
