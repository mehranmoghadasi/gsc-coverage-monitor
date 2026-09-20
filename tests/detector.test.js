import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteImpressionDrop, vanishedPages, inspectionTransition, sitemapIssues, indexBucket } from '../src/lib/detector.js';

const A = { siteDropThresholdPct: 25, pageMinBaselineImpressions: 20, baselineDays: 28, recentDays: 7 };
const days = (n, impressions) => Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, clicks: 1, impressions }));

test('site drop fires above threshold with correct pct and severity', () => {
  const r = siteImpressionDrop(days(28, 1000), days(7, 400), A);
  assert.equal(r.type, 'site_impressions_drop');
  assert.equal(r.dropPct, 60);
  assert.equal(r.severity, 'high');
  assert.equal(siteImpressionDrop(days(28, 1000), days(7, 800), A), null);
});

test('site drop ignores tiny sites and empty windows', () => {
  assert.equal(siteImpressionDrop(days(28, 5), days(7, 0), A), null);
  assert.equal(siteImpressionDrop([], days(7, 0), A), null);
});

test('vanished pages normalises per-day and respects min baseline', () => {
  const base = [
    { page: 'https://x.com/a', clicks: 30, impressions: 2800 }, // 100/day
    { page: 'https://x.com/b', clicks: 0, impressions: 10 },    // below min
    { page: 'https://x.com/c', clicks: 0, impressions: 280 },   // 10/day
  ];
  const recent = [{ page: 'https://x.com/c', clicks: 0, impressions: 60 }]; // 8.6/day → not vanished
  const v = vanishedPages(base, recent, A);
  assert.deepEqual(v.map((x) => x.subject), ['https://x.com/a']);
  assert.equal(v[0].severity, 'high');
  assert.equal(v[0].dropPct, 100);
});

test('indexBucket maps GSC verdict/coverage strings', () => {
  assert.equal(indexBucket({ verdict: 'PASS', coverageState: 'Submitted and indexed' }), 'indexed');
  assert.equal(indexBucket({ verdict: 'NEUTRAL', coverageState: 'Excluded by ‘noindex’ tag' }), 'not_indexed');
  assert.equal(indexBucket({ verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' }), 'pending');
  assert.equal(indexBucket({ verdict: 'FAIL', coverageState: 'Server error (5xx)' }), 'not_indexed');
});

test('inspection transition detects index loss, canonical mismatch, robots block', () => {
  const prev = { verdict: 'PASS', coverageState: 'Submitted and indexed' };
  const lost = inspectionTransition(prev, { url: 'u', verdict: 'NEUTRAL', coverageState: 'Excluded by ‘noindex’ tag', robotsTxtState: 'ALLOWED' });
  assert.equal(lost.type, 'index_lost');
  assert.equal(lost.severity, 'high');
  const canon = inspectionTransition(null, { url: 'u', verdict: 'NEUTRAL', coverageState: 'Duplicate, Google chose different canonical than user', userCanonical: 'u', googleCanonical: 'v' });
  assert.equal(canon.type, 'canonical_mismatch');
  const robots = inspectionTransition(null, { url: 'u', verdict: 'NEUTRAL', coverageState: 'Blocked by robots.txt', robotsTxtState: 'DISALLOWED' });
  assert.equal(robots.type, 'robots_blocked');
  assert.equal(inspectionTransition(prev, { url: 'u', verdict: 'PASS', coverageState: 'Submitted and indexed' }), null);
  assert.equal(inspectionTransition(null, { url: 'u', verdict: 'PASS', coverageState: 'Submitted and indexed' }), null);
});

test('sitemap issues: shrink, new errors, newly pending', () => {
  const cfg = { submittedDropThresholdPct: 20 };
  const prev = { path: 's', submitted: 1000, errors: 0, warnings: 0, isPending: false };
  const out = sitemapIssues(prev, { path: 's', submitted: 400, errors: 3, warnings: 1, isPending: true }, cfg);
  assert.deepEqual(out.map((o) => o.type), ['sitemap_shrank', 'sitemap_errors', 'sitemap_pending']);
  assert.equal(out[0].dropPct, 60);
  assert.deepEqual(sitemapIssues(null, { path: 's', submitted: 10, errors: 0, warnings: 0, isPending: false }, cfg), []);
});
