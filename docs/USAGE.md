# Usage

## Commands

| Command | Purpose | Exit code |
|---|---|---|
| `gsc-monitor poll` | Fetch, store, detect, alert | 1 if new issues, else 0 |
| `gsc-monitor report --days 30 --out reports/` | Markdown + JSON report | 0 |
| `gsc-monitor status` | One line per property (7-day totals + open high-severity) | 0 |
| `gsc-monitor inspect <url…>` | Ad-hoc URL Inspection (uses quota) | 0 |

Common options: `--config <path>`, `--property <siteUrl>`, `--dry-run`, `--today YYYY-MM-DD`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | — | service-account JSON path |
| `ALERT_WEBHOOK_URL` | — | Slack / Discord / Teams incoming webhook |
| `GSC_MONITOR_DB` | `./data/gsc-monitor.db` | SQLite file |
| `GSC_MONITOR_CONFIG` | `./gsc-monitor.json` | config path |
| `GSC_MONITOR_FAKE_API` | — | module path replacing the Google adapter (demo/tests) |

## Reading an alert

- **Impressions collapsed** — site-wide; check for a manual action, a robots.txt change, or a migration.
- **Page vanished from search** — the page had steady impressions and now has none; it is inspected the same run.
- **URL dropped out of the index** — the previous inspection said PASS, this one does not; `details.to` holds Google's coverage state (`noindex`, `Not found (404)`, `Blocked by robots.txt`, `Duplicate…`).
- **Sitemap lost URLs / has errors / not yet processed** — the submitted count fell, Google reported errors, or the sitemap has never been fetched.

## Scheduling

Run once a day after ~07:00 in your timezone. GitHub Actions example:

```yaml
on:
  schedule: [{ cron: "30 13 * * *" }]   # 07:30 America/Edmonton in UTC
jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: echo "$GSC_SA_JSON" > sa.json
        env: { GSC_SA_JSON: ${{ secrets.GSC_SA_JSON }} }
      - run: npx gsc-monitor poll
        env:
          GOOGLE_APPLICATION_CREDENTIALS: ./sa.json
          ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}
```
Persist `data/gsc-monitor.db` between runs (cache action or an artifact) so history and de-duplication survive.
