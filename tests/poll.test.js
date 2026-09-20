import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/lib/db.js';
import { normalizeConfig } from '../src/config.js';
import { pollProperty } from '../src/lib/poll.js';
import { analyticsWindows } from '../src/lib/dates.js';

const cfg = normalizeConfig({ properties: [{ siteUrl: 'sc-domain:x.com', label: 'X', sitemaps: ['https://x.com/sitemap.xml'] }], inspection: { dailyBudget: 3 } });
const site = cfg.properties[0];
const TODAY = '2026-09-19';

function fakeApi(state) {
  return {
    calls: [],
    async queryDaily() {
      const w = analyticsWindows(cfg.analytics, TODAY);
      const out = [];
      for (let d = new Date(`${w.baselineStart}T00:00:00Z`); d <= new Date(`${w.recentEnd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        out.push({ date, clicks: 10, impressions: date >= w.recentStart ? state.recentImpr : 1000 });
      }
      return out;
    },
    async queryPages(_s, start) {
      const w = analyticsWindows(cfg.analytics, TODAY);
      if (start === w.baselineStart) return [{ page: 'https://x.com/hero', clicks: 50, impressions: 2800 }, { page: 'https://x.com/ok', clicks: 5, impressions: 560 }];
      return state.heroAlive ? [{ page: 'https://x.com/hero', clicks: 12, impressions: 700 }, { page: 'https://x.com/ok', clicks: 1, impressions: 140 }] : [{ page: 'https://x.com/ok', clicks: 1, impressions: 140 }];
    },
    async listSitemaps() { return [{ path: 'https://x.com/sitemap.xml', submitted: state.submitted, errors: 0, warnings: 0, isPending: false, lastDownloaded: null }]; },
    async fetchSitemapUrls() { return ['https://x.com/hero', 'https://x.com/ok', 'https://x.com/new', 'https://other.com/x']; },
    async inspectUrl(_s, url) {
      this.calls.push(url);
      if (url === 'https://x.com/hero' && !state.heroAlive) return { url, verdict: 'NEUTRAL', coverageState: 'Excluded by ‘noindex’ tag', robotsTxtState: 'ALLOWED' };
      return { url, verdict: 'PASS', coverageState: 'Submitted and indexed' };
    },
  };
}

test('healthy day: no regressions, budget spent on never-inspected URLs, foreign URLs ignored', async () => {
  const db = openDatabase(':memory:');
  const api = fakeApi({ recentImpr: 1000, heroAlive: true, submitted: 100 });
  const r = await pollProperty({ db, api, cfg, property: site, today: TODAY });
  assert.equal(r.regressions.length, 0);
  assert.equal(r.inspected, 3);
  assert.equal(r.pagesTracked, 3); // other.com excluded
  assert.ok(!api.calls.includes('https://other.com/x'));
});

test('bad day: vanished page is inspected first and index loss is confirmed; site drop + sitemap shrink recorded', async () => {
  const db = openDatabase(':memory:');
  // day 1 healthy → establishes an indexed baseline for /hero and a sitemap snapshot
  await pollProperty({ db, api: fakeApi({ recentImpr: 1000, heroAlive: true, submitted: 100 }), cfg, property: site, today: '2026-09-18' });
  const api = fakeApi({ recentImpr: 300, heroAlive: false, submitted: 40 });
  const r = await pollProperty({ db, api, cfg, property: site, today: TODAY });
  const types = r.regressions.map((x) => x.type).sort();
  assert.deepEqual(types, ['index_lost', 'page_vanished', 'site_impressions_drop', 'sitemap_shrank']);
  assert.equal(api.calls[0], 'https://x.com/hero');
  const lost = r.regressions.find((x) => x.type === 'index_lost');
  assert.equal(lost.details.from, 'Submitted and indexed');
  // re-running the same day does not duplicate
  const again = await pollProperty({ db, api: fakeApi({ recentImpr: 300, heroAlive: false, submitted: 40 }), cfg, property: site, today: TODAY });
  assert.equal(again.regressions.length, 0);
});

test('config validation rejects bad input', () => {
  assert.throws(() => normalizeConfig({ properties: [] }), /non-empty/);
  assert.throws(() => normalizeConfig({ properties: [{ siteUrl: 'x.com' }] }), /siteUrl/);
  assert.throws(() => normalizeConfig({ properties: [{ siteUrl: 'sc-domain:x.com' }], inspection: { dailyBudget: 5000 } }), /2,000/);
  const c = normalizeConfig({ properties: [{ siteUrl: 'https://x.com/' }] });
  assert.equal(c.analytics.dataLagDays, 3);
  assert.equal(c.properties[0].label, 'https://x.com/');
});
