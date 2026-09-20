import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDigest, sendWebhook } from '../src/lib/alerts.js';
import { renderMarkdown } from '../src/lib/report.js';

const regs = [
  { siteUrl: 'sc-domain:x.com', detectedAt: '2026-09-19', type: 'page_vanished', subject: 'https://x.com/a', baseline: 100, current: 0, dropPct: 100, severity: 'high', details: { baselineClicks: 50 } },
  { siteUrl: 'sc-domain:x.com', detectedAt: '2026-09-19', type: 'sitemap_pending', subject: 'https://x.com/s.xml', baseline: 0, current: 0, dropPct: 0, severity: 'low', details: {} },
  { siteUrl: 'https://y.com/', detectedAt: '2026-09-19', type: 'site_impressions_drop', subject: 'site', baseline: 5000, current: 1200, dropPct: 76, severity: 'high', details: {} },
];

test('digest groups by property, orders by severity, uses labels', () => {
  const d = formatDigest(regs, { 'sc-domain:x.com': 'X Co' });
  assert.match(d, /3 new issues/);
  assert.ok(d.indexOf('*X Co*') < d.indexOf('*https:\/\/y.com\/*'));
  assert.ok(d.indexOf('Page vanished') < d.indexOf('Sitemap not yet processed'));
  assert.match(d, /5,000 → 1,200 impressions\/day \(−76%\)/);
  assert.equal(formatDigest([]), '');
});

test('webhook posts JSON and surfaces failures', async () => {
  let body;
  const ok = await sendWebhook('https://hook', 'hi', async (_u, init) => { body = JSON.parse(init.body); return { ok: true }; });
  assert.equal(ok, true);
  assert.equal(body.text, 'hi');
  await assert.rejects(sendWebhook('https://hook', 'hi', async () => ({ ok: false, status: 500 })), /500/);
  assert.equal(await sendWebhook('', 'hi'), false);
});

test('markdown report renders table and issues', () => {
  const md = renderMarkdown({ generatedAt: '2026-09-19', since: '2026-08-20', days: 30, sites: [{ label: 'X', daysWithData: 30, clicks: 10, impressions: 100, knownUrls: 5, inspected: { PASS: 3, NEUTRAL: 1 } }], regressions: regs.slice(0, 1) });
  assert.match(md, /\| X \| 30 \| 10 \| 100 \| 5 \| 3 \| 1 \|/);
  assert.match(md, /Issues detected \(1\)/);
});
