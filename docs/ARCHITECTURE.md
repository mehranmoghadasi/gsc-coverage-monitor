# Architecture

## Data flow per `poll`

1. **Windows** — `dates.analyticsWindows` derives `[baselineStart…baselineEnd]` and `[recentStart…recentEnd]` from today minus `dataLagDays`. Both are passed to Google as explicit dates; nothing is computed on partial days.
2. **Search Analytics** — one `date`-dimension query covers both windows (≤ 35 rows). Two `page`-dimension queries (one per window) are paginated 25k rows at a time and stored in `page_window`. `detector.siteImpressionDrop` and `detector.vanishedPages` run on these.
3. **Sitemaps** — `sitemaps.list` gives submitted/errors/warnings/isPending. The previous snapshot for the same path is loaded for diffing. Sitemap XML is fetched directly to seed `known_url` (GSC has no "list my URLs" endpoint).
4. **URL Inspection** — `sampler.pickInspectionSample` orders vanished pages first, then URLs due by age, capped at `dailyBudget`. Each result is stored in `inspection`; `detector.inspectionTransition` compares against the previous stored record.
5. **Regressions** — inserted with `UNIQUE (site_url, type, subject, detected_at)` so a re-run on the same day is idempotent. `pendingRegressions` (notified_at IS NULL) become the digest; on send they are stamped.

## Why the API is injected

`poll.js` takes an `api` object with five async functions. `index.js` builds it from `gsc.js` in production, or from `$GSC_MONITOR_FAKE_API` for demos and tests. This keeps `googleapis` out of the test process entirely and lets `tests/poll.test.js` run the real pipeline against a scripted incident.

## Quota

- Search Analytics: 1,200 QPM per project; the adapter waits 1.1 s between calls and retries 429/5xx with backoff.
- URL Inspection: 2,000/day/property. `dailyBudget` is validated ≤ 2,000; default 50.

## Storage

SQLite via `node:sqlite` in WAL mode. Tables: `site_daily`, `page_window`, `sitemap_snapshot`, `known_url`, `inspection`, `regression`. Everything is keyed by `site_url`; one file serves many properties.
