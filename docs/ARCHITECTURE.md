# Architecture — gsc-coverage-monitor

## Component Overview

```
src/
├── index.js      Commander CLI shell — routes commands to orchestration logic
├── config.js     Unified config loader (env vars → JSON file → defaults)
└── lib/
    ├── auth.js      Google auth client factory (service account + OAuth2)
    ├── gsc.js       Search Console API wrapper with rate-limit and retry
    ├── db.js        SQLite CRUD layer (better-sqlite3, WAL mode)
    ├── detector.js  Regression detection algorithm and health summary
    ├── alerts.js    Email dispatch (Nodemailer) and CSV writer (fast-csv)
    └── report.js    Terminal table renderer (chalk) and plain-text file writer
```

## Data Flow

1. **Config load** — `config.js` merges `.env` and optional JSON config, validates required fields, and returns a typed config object. Fails fast with a clear error if mandatory fields are missing.

2. **Authentication** — `auth.js` reads the credentials file and detects whether it's a service account or an OAuth2 authorized_user token. Returns a GoogleAuth client ready for API calls.

3. **Polling** — `gsc.js` iterates through each configured property, calling `sitemaps.list` to retrieve URL counts. A 1100ms sleep between requests keeps the project within Google's 1 QPS quota. Transient HTTP errors (429, 5xx) are retried with exponential backoff (max 3 attempts).

4. **Storage** — `db.js` uses `better-sqlite3` (synchronous) for simplicity in a scheduled CLI context. `upsertSnapshots` wraps all writes in a single SQLite transaction. WAL mode allows concurrent reads while writing.

5. **Detection** — `detector.js` computes a rolling baseline mean over the configured window (default 7 days), excluding the current snapshot. A drop ≥ `threshold`% triggers a `Regression` object. The minimum-history guard (3 snapshots) prevents false positives on new properties.

6. **Alerting** — `alerts.js` dispatches email via Nodemailer (HTML + plain-text) and writes CSV files. Each regression is marked `alerted_at` in SQLite after a successful email send, preventing duplicate alerts.

7. **Reporting** — `report.js` renders a coloured table to stdout via chalk, and writes a timestamped `.txt` file for log aggregation.

## Database Schema

```sql
snapshots    — one row per property per poll date (UNIQUE(site_url, poll_date))
regressions  — one row per detected drop, with alerted_at and acknowledged flags
```

## Design Decisions

- **SQLite over Postgres** — zero infrastructure. A cron job + one file is all that's needed for an agency workflow.
- **Synchronous DB API** — `better-sqlite3` synchronous methods simplify the poll loop; there's no benefit to async here since each DB write is fast and sequential.
- **Rate-limit in the client, not a queue** — the 1.1s sleep is simpler than a queue library for a CLI tool that's not high-frequency.
- **Regression history retained in DB** — all regressions persist even after acknowledgement, enabling historical trend analysis in a future dashboard phase.
