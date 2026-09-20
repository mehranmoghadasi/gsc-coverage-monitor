/** alerts.js — format regressions for humans and push them to a webhook / CSV. */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LABEL = {
  site_impressions_drop: 'Impressions collapsed',
  page_vanished: 'Page vanished from search',
  index_lost: 'URL dropped out of the index',
  canonical_mismatch: 'Google chose a different canonical',
  robots_blocked: 'URL now blocked by robots.txt',
  sitemap_shrank: 'Sitemap lost URLs',
  sitemap_errors: 'Sitemap has errors',
  sitemap_pending: 'Sitemap not yet processed',
};

export function describe(r) {
  switch (r.type) {
    case 'site_impressions_drop': return `${r.baseline.toLocaleString()} → ${r.current.toLocaleString()} impressions/day (−${r.dropPct}%)`;
    case 'page_vanished': return `${r.baseline}/day → ${r.current}/day impressions (${r.details.baselineClicks} clicks in baseline)`;
    case 'index_lost': return `${r.details.from} → ${r.details.to}${r.details.robots ? ` · robots: ${r.details.robots}` : ''}`;
    case 'canonical_mismatch': return `declared ${r.details.userCanonical} · Google picked ${r.details.googleCanonical}`;
    case 'robots_blocked': return r.details.state;
    case 'sitemap_shrank': return `${r.baseline.toLocaleString()} → ${r.current.toLocaleString()} submitted URLs (−${r.dropPct}%)`;
    case 'sitemap_errors': return `${r.current} errors, ${r.details.warnings ?? 0} warnings`;
    case 'sitemap_pending': return 'Google has not fetched this sitemap since submission';
    default: return JSON.stringify(r.details);
  }
}

/** Group by property, order by severity. Returns Markdown that reads fine in Slack/Discord/Teams too. */
export function formatDigest(regressions, labels = {}) {
  if (!regressions.length) return '';
  const order = { high: 0, medium: 1, low: 2 };
  const icon = { high: '🔴', medium: '🟠', low: '🟡' };
  const bySite = new Map();
  for (const r of regressions) bySite.set(r.siteUrl, [...(bySite.get(r.siteUrl) ?? []), r]);
  const lines = [`*GSC Coverage Monitor — ${regressions.length} new issue${regressions.length === 1 ? '' : 's'}*`];
  for (const [site, list] of bySite) {
    lines.push('', `*${labels[site] ?? site}*`);
    for (const r of list.sort((a, b) => order[a.severity] - order[b.severity])) {
      lines.push(`${icon[r.severity]} ${LABEL[r.type] ?? r.type} — ${r.subject === 'site' ? '' : `${r.subject} — `}${describe(r)}`);
    }
  }
  return lines.join('\n');
}

export async function sendWebhook(url, text, fetchImpl = fetch) {
  if (!url) return false;
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  return true;
}

export function appendAlertsCsv(path, regressions) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, 'detected_at,site_url,severity,type,subject,baseline,current,drop_pct,details\n');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  for (const r of regressions) {
    appendFileSync(path, [r.detectedAt, r.siteUrl, r.severity, r.type, r.subject, r.baseline, r.current, r.dropPct, JSON.stringify(r.details)].map(esc).join(',') + '\n');
  }
}
