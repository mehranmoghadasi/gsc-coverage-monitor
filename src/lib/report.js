/** report.js — Markdown / JSON status report over the last N days. */
import { describe } from './alerts.js';
import { addDays } from './dates.js';
import { latestInspectionSummary, knownUrlCount, regressionsSince, siteDailyBetween } from './db.js';

export function buildReport(db, cfg, days, today) {
  const since = addDays(today, -days);
  const sites = cfg.properties.map((p) => {
    const daily = siteDailyBetween(db, p.siteUrl, since, today);
    const clicks = daily.reduce((s, r) => s + r.clicks, 0);
    const impressions = daily.reduce((s, r) => s + r.impressions, 0);
    const insp = Object.fromEntries(latestInspectionSummary(db, p.siteUrl).map((r) => [r.verdict ?? 'UNKNOWN', r.n]));
    return { siteUrl: p.siteUrl, label: p.label, daysWithData: daily.length, clicks, impressions, knownUrls: knownUrlCount(db, p.siteUrl), inspected: insp };
  });
  const regressions = regressionsSince(db, since);
  return { generatedAt: today, since, days, sites, regressions };
}

export function renderMarkdown(rep) {
  const L = [`# GSC Coverage Monitor — ${rep.days}-day report`, '', `Generated ${rep.generatedAt} · window ${rep.since} → ${rep.generatedAt}`, ''];
  L.push('| Property | Days | Clicks | Impressions | Known URLs | Inspected PASS | Inspected other |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const s of rep.sites) {
    const pass = s.inspected.PASS ?? 0;
    const other = Object.entries(s.inspected).filter(([k]) => k !== 'PASS').reduce((n, [, v]) => n + v, 0);
    L.push(`| ${s.label} | ${s.daysWithData} | ${s.clicks.toLocaleString()} | ${s.impressions.toLocaleString()} | ${s.knownUrls.toLocaleString()} | ${pass} | ${other} |`);
  }
  L.push('', `## Issues detected (${rep.regressions.length})`, '');
  if (!rep.regressions.length) L.push('_None._');
  else {
    L.push('| Detected | Property | Severity | Type | Subject | Detail |', '|---|---|---|---|---|---|');
    for (const r of rep.regressions) L.push(`| ${r.detectedAt} | ${r.siteUrl} | ${r.severity} | ${r.type} | ${r.subject} | ${describe(r)} |`);
  }
  return L.join('\n') + '\n';
}
