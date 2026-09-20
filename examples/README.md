# Examples

- `fake-api.js` — drop-in replacement for the Google adapter that simulates a site losing 60% of impressions, one service page getting a stray `noindex`, and a shrinking sitemap.
- `gsc-monitor.demo.json` — a one-property config for the demo.

```bash
export GSC_MONITOR_FAKE_API=./examples/fake-api.js GSC_MONITOR_DB=./data/demo.db
npx gsc-monitor poll --config examples/gsc-monitor.demo.json --dry-run --today 2026-09-08
npx gsc-monitor poll --config examples/gsc-monitor.demo.json --dry-run --today 2026-09-19
npx gsc-monitor report --config examples/gsc-monitor.demo.json --today 2026-09-19
```
