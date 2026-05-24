/**
 * db.js — SQLite data layer for gsc-coverage-monitor
 *
 * Uses better-sqlite3 (synchronous API) for simplicity and reliability
 * in a scheduled CLI context. All writes are wrapped in a single
 * transaction to prevent partial snapshots.
 *
 * Schema:
 *   snapshots    — one row per property per poll cycle
 *   regressions  — detected coverage drops, with acknowledgement status
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * Open (or create) the SQLite database and apply the schema.
 *
 * @param {string} dbPath - Filesystem path for the SQLite file
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site_url        TEXT    NOT NULL,
      poll_date       TEXT    NOT NULL,
      submitted_urls  INTEGER NOT NULL DEFAULT 0,
      indexed_urls    INTEGER NOT NULL DEFAULT 0,
      error_urls      INTEGER NOT NULL DEFAULT 0,
      warning_urls    INTEGER NOT NULL DEFAULT 0,
      excluded_urls   INTEGER NOT NULL DEFAULT 0,
      sitemap_count   INTEGER NOT NULL DEFAULT 0,
      fetch_error     TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_url, poll_date)
    );

    CREATE TABLE IF NOT EXISTS regressions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site_url        TEXT    NOT NULL,
      detected_date   TEXT    NOT NULL,
      baseline_avg    REAL    NOT NULL,
      current_indexed INTEGER NOT NULL,
      drop_pct        REAL    NOT NULL,
      acknowledged    INTEGER NOT NULL DEFAULT 0,
      alerted_at      TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_site_date
      ON snapshots(site_url, poll_date);

    CREATE INDEX IF NOT EXISTS idx_regressions_site_date
      ON regressions(site_url, detected_date);
  `);

  return _db;
}

/**
 * Insert or replace a coverage snapshot.
 * Uses INSERT OR REPLACE to handle re-polls on the same day gracefully.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} snapshot - CoverageSnapshot from gsc.js
 */
export function upsertSnapshot(db, snapshot) {
  const stmt = db.prepare(`
    INSERT INTO snapshots
      (site_url, poll_date, submitted_urls, indexed_urls, error_urls, warning_urls, excluded_urls, sitemap_count, fetch_error)
    VALUES
      (@siteUrl, @date, @submittedUrls, @indexedUrls, @errorUrls, @warningUrls, @excludedUrls, @sitemapCount, @error)
    ON CONFLICT(site_url, poll_date) DO UPDATE SET
      submitted_urls = excluded.submitted_urls,
      indexed_urls   = excluded.indexed_urls,
      error_urls     = excluded.error_urls,
      warning_urls   = excluded.warning_urls,
      excluded_urls  = excluded.excluded_urls,
      sitemap_count  = excluded.sitemap_count,
      fetch_error    = excluded.fetch_error,
      created_at     = datetime('now')
  `);

  stmt.run({
    siteUrl: snapshot.siteUrl,
    date: snapshot.date,
    submittedUrls: snapshot.submittedUrls ?? 0,
    indexedUrls: snapshot.indexedUrls ?? 0,
    errorUrls: snapshot.errorUrls ?? 0,
    warningUrls: snapshot.warningUrls ?? 0,
    excludedUrls: snapshot.excludedUrls ?? 0,
    sitemapCount: snapshot.sitemapCount ?? 0,
    error: snapshot.error ?? null,
  });
}

/**
 * Bulk-insert snapshots in a single transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} snapshots
 */
export function upsertSnapshots(db, snapshots) {
  const insert = db.transaction((items) => {
    for (const item of items) {
      upsertSnapshot(db, item);
    }
  });
  insert(snapshots);
}

/**
 * Fetch recent snapshots for a property, ordered oldest-first.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} siteUrl
 * @param {number} [days=30]
 * @returns {object[]}
 */
export function getRecentSnapshots(db, siteUrl, days = 30) {
  return db.prepare(`
    SELECT *
    FROM snapshots
    WHERE site_url = ?
      AND poll_date >= date('now', ? || ' days')
      AND fetch_error IS NULL
    ORDER BY poll_date ASC
  `).all(siteUrl, `-${days}`);
}

/**
 * Get the most recent snapshot for each configured property.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} siteUrls
 * @returns {object[]}
 */
export function getLatestSnapshots(db, siteUrls) {
  return siteUrls.map((url) =>
    db.prepare(`
      SELECT * FROM snapshots
      WHERE site_url = ? AND fetch_error IS NULL
      ORDER BY poll_date DESC
      LIMIT 1
    `).get(url)
  ).filter(Boolean);
}

/**
 * Record a detected regression.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} regression
 * @param {string} regression.siteUrl
 * @param {string} regression.detectedDate
 * @param {number} regression.baselineAvg
 * @param {number} regression.currentIndexed
 * @param {number} regression.dropPct
 */
export function insertRegression(db, regression) {
  db.prepare(`
    INSERT INTO regressions (site_url, detected_date, baseline_avg, current_indexed, drop_pct)
    VALUES (@siteUrl, @detectedDate, @baselineAvg, @currentIndexed, @dropPct)
  `).run(regression);
}

/**
 * Mark a regression as alerted (sets alerted_at timestamp).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 */
export function markRegressionAlerted(db, id) {
  db.prepare(`
    UPDATE regressions SET alerted_at = datetime('now') WHERE id = ?
  `).run(id);
}

/**
 * Get all unacknowledged, unalerted regressions.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function getPendingRegressions(db) {
  return db.prepare(`
    SELECT * FROM regressions
    WHERE acknowledged = 0 AND alerted_at IS NULL
    ORDER BY detected_date DESC
  `).all();
}

/**
 * Get all snapshots across all properties for summary report.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} [days=30]
 * @returns {object[]}
 */
export function getAllSnapshots(db, days = 30) {
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE poll_date >= date('now', ? || ' days')
    ORDER BY site_url, poll_date ASC
  `).all(`-${days}`);
}

/**
 * Return a count of snapshots per property — useful for status checks.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ siteUrl: string, count: number }[]}
 */
export function getSnapshotCounts(db) {
  return db.prepare(`
    SELECT site_url AS siteUrl, COUNT(*) AS count
    FROM snapshots
    GROUP BY site_url
    ORDER BY count DESC
  `).all();
}
