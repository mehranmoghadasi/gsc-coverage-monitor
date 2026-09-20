#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * gsc-monitor — CLI entry point.
 *
 *   gsc-monitor poll     run one monitoring pass over every property, alert on new issues
 *   gsc-monitor report   Markdown/JSON report for the last N days
 *   gsc-monitor status   one-line health per property
 *   gsc-monitor inspect  ad-hoc URL Inspection for one or more URLs
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDotEnv, loadConfig, envSettings } from './config.js';
import { openDatabase, pendingRegressions, markNotified } from './lib/db.js';
import { isoDate } from './lib/dates.js';
import { pollProperty } from './lib/poll.js';
import { formatDigest, sendWebhook, appendAlertsCsv } from './lib/alerts.js';
import { buildReport, renderMarkdown } from './lib/report.js';
import { fetchSitemapUrls } from './lib/sitemap.js';

const HELP = `gsc-monitor <command> [options]

Commands:
  poll                 fetch analytics + sitemaps + inspect a URL sample; store; alert on new issues
  report               write a Markdown (+JSON) report      --days 30  --out reports/
  status               print a one-line summary per property
  inspect <url...>     run URL Inspection on the given URLs (counts against quota)

Options:
  --config <path>      default gsc-monitor.json (or $GSC_MONITOR_CONFIG)
  --property <siteUrl> limit poll/inspect to one property
  --dry-run            poll without sending webhook alerts
  --today <YYYY-MM-DD> override "today" (testing / backfill)
  -h, --help
`;

async function buildApi() {
  // Test hook: GSC_MONITOR_FAKE_API=./path/to/module.js exporting a default api object.
  if (process.env.GSC_MONITOR_FAKE_API) return (await import(new URL(process.env.GSC_MONITOR_FAKE_API, `file://${process.cwd()}/`))).default;
  const { createAuth, createClients, queryDaily, queryPages, listSitemaps, inspectUrl } = await import('./lib/gsc.js');
  const { credentialsPath } = envSettings();
  const auth = await createAuth(credentialsPath);
  const clients = createClients(auth);
  return {
    queryDaily: (site, a, b) => queryDaily(clients, site, a, b),
    queryPages: (site, a, b) => queryPages(clients, site, a, b),
    listSitemaps: (site) => listSitemaps(clients, site),
    inspectUrl: (site, url) => inspectUrl(clients, site, url),
    fetchSitemapUrls: (u) => fetchSitemapUrls(u),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' }, property: { type: 'string' }, days: { type: 'string', default: '30' },
      out: { type: 'string', default: 'reports' }, 'dry-run': { type: 'boolean', default: false },
      today: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) { process.stdout.write(HELP); return 0; }

  loadDotEnv();
  const cfg = loadConfig(values.config);
  const env = envSettings();
  const db = openDatabase(env.dbPath);
  const today = values.today ?? isoDate();
  process.env.GSC_MONITOR_TODAY = today;
  const labels = Object.fromEntries(cfg.properties.map((p) => [p.siteUrl, p.label]));
  const props = values.property ? cfg.properties.filter((p) => p.siteUrl === values.property) : cfg.properties;
  if (!props.length) throw new Error(`property not in config: ${values.property}`);

  if (command === 'poll') {
    const api = await buildApi();
    let total = 0;
    for (const p of props) {
      process.stdout.write(`▶ ${p.label} (${p.siteUrl})\n`);
      try {
        const r = await pollProperty({ db, api, cfg, property: p, today, log: (m) => process.stdout.write(`${m}\n`) });
        total += r.regressions.length;
        process.stdout.write(`  ${r.regressions.length} new issue(s) · ${r.pagesTracked} URLs tracked\n`);
      } catch (err) {
        process.stdout.write(`  ✖ ${err.message}\n`);
      }
    }
    const pending = pendingRegressions(db);
    if (pending.length) {
      const digest = formatDigest(pending, labels);
      process.stdout.write(`\n${digest}\n`);
      appendAlertsCsv(`${values.out}/alerts.csv`, pending);
      if (!values['dry-run'] && env.webhookUrl) {
        await sendWebhook(env.webhookUrl, digest);
        process.stdout.write(`\n✔ alert sent to webhook\n`);
      }
      markNotified(db, pending.map((r) => r.id), new Date().toISOString());
    } else {
      process.stdout.write('\n✔ no new issues\n');
    }
    return total ? 1 : 0;
  }

  if (command === 'report') {
    const rep = buildReport(db, cfg, Number(values.days), today);
    mkdirSync(values.out, { recursive: true });
    const md = `${values.out}/report-${today}.md`;
    writeFileSync(md, renderMarkdown(rep));
    writeFileSync(`${values.out}/report-${today}.json`, JSON.stringify(rep, null, 2));
    process.stdout.write(renderMarkdown(rep));
    process.stdout.write(`\nSaved ${md}\n`);
    return 0;
  }

  if (command === 'status') {
    const rep = buildReport(db, cfg, 7, today);
    for (const s of rep.sites) {
      const open = rep.regressions.filter((r) => r.siteUrl === s.siteUrl && r.severity === 'high').length;
      process.stdout.write(`${open ? '🔴' : '🟢'} ${s.label.padEnd(24)} 7d: ${s.clicks.toLocaleString()} clicks / ${s.impressions.toLocaleString()} impr · ${s.knownUrls} URLs · ${open} high-severity\n`);
    }
    return 0;
  }

  if (command === 'inspect') {
    if (!rest.length) throw new Error('inspect needs at least one URL');
    const api = await buildApi();
    const p = props[0];
    for (const url of rest) {
      const r = await api.inspectUrl(p.siteUrl, url);
      process.stdout.write(`${r.verdict.padEnd(8)} ${r.coverageState.padEnd(40)} ${url}\n`);
      if (r.googleCanonical && r.googleCanonical !== url) process.stdout.write(`         canonical → ${r.googleCanonical}\n`);
    }
    return 0;
  }

  throw new Error(`unknown command: ${command}\n\n${HELP}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((err) => { process.stderr.write(`error: ${err.message}\n`); process.exit(2); });
}
