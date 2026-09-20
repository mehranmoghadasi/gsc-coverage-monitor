/**
 * A stand-in for lib/gsc.js so you can try the CLI without Google credentials:
 *   GSC_MONITOR_FAKE_API=./examples/fake-api.js gsc-monitor poll --config examples/gsc-monitor.demo.json --dry-run
 * It simulates a site that lost 60% of its impressions, one page that vanished and was de-indexed, and a sitemap that shrank.
 */
const day = (i) => new Date(Date.UTC(2026, 7, 10 + i)).toISOString().slice(0, 10);
export default {
  async queryDaily(_site, start, end) {
    const out = [];
    for (let i = 0; i < 45; i++) {
      const d = day(i);
      if (d < start || d > end) continue;
      out.push({ date: d, clicks: d >= '2026-09-10' ? 40 : 110, impressions: d >= '2026-09-10' ? 1800 : 4600 });
    }
    return out;
  },
  async queryPages(_site, start) {
    const base = [
      { page: 'https://demo.example.com/', clicks: 900, impressions: 40000 },
      { page: 'https://demo.example.com/services/furnace-repair', clicks: 320, impressions: 9800 },
      { page: 'https://demo.example.com/blog/how-often-to-service-a-furnace', clicks: 140, impressions: 6200 },
      { page: 'https://demo.example.com/areas/calgary-nw', clicks: 12, impressions: 900 },
    ];
    if (start < '2026-09-05') return base;
    return base.filter((p) => !p.page.includes('furnace-repair')).map((p) => ({ ...p, clicks: Math.round(p.clicks / 4), impressions: Math.round(p.impressions / 4) }));
  },
  async listSitemaps() {
    return [{ path: 'https://demo.example.com/sitemap.xml', submitted: 212, errors: 0, warnings: 2, isPending: false, lastDownloaded: '2026-09-15T02:11:00Z' }];
  },
  async fetchSitemapUrls() {
    return ['https://demo.example.com/', 'https://demo.example.com/services/furnace-repair', 'https://demo.example.com/services/ac-install', 'https://demo.example.com/contact'];
  },
  async inspectUrl(_site, url) {
    const today = process.env.GSC_MONITOR_TODAY ?? '2026-09-19';
    if (url.includes('furnace-repair') && today >= '2026-09-10') return { url, verdict: 'NEUTRAL', coverageState: 'Excluded by ‘noindex’ tag', indexingState: 'BLOCKED_BY_META_TAG', robotsTxtState: 'ALLOWED', lastCrawlTime: '2026-09-14T08:41:00Z', googleCanonical: null, userCanonical: url };
    return { url, verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED', lastCrawlTime: '2026-09-12T01:00:00Z', googleCanonical: url, userCanonical: url };
  },
};
