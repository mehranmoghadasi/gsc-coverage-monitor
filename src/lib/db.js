/**
 * db.js — SQLite persistence on Node's built-in `node:sqlite` (no native build step).
 *
 * Every table is keyed by siteUrl so one database serves many properties.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_daily (
  site_url TEXT NOT NULL, date TEXT NOT NULL,
  clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, pages INTEGER NOT NULL,
  PRIMARY KEY (site_url, date)
);
CREATE TABLE IF NOT EXISTS page_window (
  site_url TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  page TEXT NOT NULL, clicks INTEGER NOT NULL, impressions INTEGER NOT NULL,
  PRIMARY KEY (site_url, window_start, window_end, page)
);
CREATE TABLE IF NOT EXISTS sitemap_snapshot (
  site_url TEXT NOT NULL, date TEXT NOT NULL, path TEXT NOT NULL,
  submitted INTEGER NOT NULL, errors INTEGER NOT NULL, warnings INTEGER NOT NULL,
  is_pending INTEGER NOT NULL, last_downloaded TEXT,
  PRIMARY KEY (site_url, date, path)
);
CREATE TABLE IF NOT EXISTS known_url (
  site_url TEXT NOT NULL, url TEXT NOT NULL, source TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_inspected TEXT,
  PRIMARY KEY (site_url, url)
);
CREATE TABLE IF NOT EXISTS inspection (
  site_url TEXT NOT NULL, url TEXT NOT NULL, checked_at TEXT NOT NULL,
  verdict TEXT, coverage_state TEXT, indexing_state TEXT, robots_txt_state TEXT,
  last_crawl_time TEXT, google_canonical TEXT, user_canonical TEXT,
  PRIMARY KEY (site_url, url, checked_at)
);
CREATE TABLE IF NOT EXISTS regression (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_url TEXT NOT NULL, detected_at TEXT NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL,
  baseline REAL NOT NULL, current REAL NOT NULL, drop_pct REAL NOT NULL, severity TEXT NOT NULL,
  details TEXT NOT NULL, notified_at TEXT,
  UNIQUE (site_url, type, subject, detected_at)
);
CREATE INDEX IF NOT EXISTS idx_regression_open ON regression (notified_at, detected_at);
`;

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// ── writes ──────────────────────────────────────────────────────────────────

export function upsertSiteDaily(db, siteUrl, rows) {
  const stmt = db.prepare(`INSERT INTO site_daily (site_url, date, clicks, impressions, pages) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site_url, date) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, pages = excluded.pages`);
  for (const r of rows) stmt.run(siteUrl, r.date, r.clicks, r.impressions, r.pages ?? 0);
}

export function replacePageWindow(db, siteUrl, windowStart, windowEnd, pages) {
  db.prepare('DELETE FROM page_window WHERE site_url = ? AND window_start = ? AND window_end = ?').run(siteUrl, windowStart, windowEnd);
  const stmt = db.prepare('INSERT INTO page_window (site_url, window_start, window_end, page, clicks, impressions) VALUES (?, ?, ?, ?, ?, ?)');
  for (const p of pages) stmt.run(siteUrl, windowStart, windowEnd, p.page, p.clicks, p.impressions);
}

export function upsertSitemapSnapshot(db, siteUrl, date, snap) {
  db.prepare(`INSERT INTO sitemap_snapshot (site_url, date, path, submitted, errors, warnings, is_pending, last_downloaded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_url, date, path) DO UPDATE SET submitted = excluded.submitted, errors = excluded.errors, warnings = excluded.warnings, is_pending = excluded.is_pending, last_downloaded = excluded.last_downloaded`)
    .run(siteUrl, date, snap.path, snap.submitted, snap.errors, snap.warnings, snap.isPending ? 1 : 0, snap.lastDownloaded ?? null);
}

export function previousSitemapSnapshot(db, siteUrl, path, beforeDate) {
  const r = db.prepare('SELECT * FROM sitemap_snapshot WHERE site_url = ? AND path = ? AND date < ? ORDER BY date DESC LIMIT 1').get(siteUrl, path, beforeDate);
  return r ? { path: r.path, submitted: r.submitted, errors: r.errors, warnings: r.warnings, isPending: !!r.is_pending, lastDownloaded: r.last_downloaded } : null;
}

export function addKnownUrls(db, siteUrl, urls, source, today) {
  const stmt = db.prepare('INSERT OR IGNORE INTO known_url (site_url, url, source, first_seen) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const u of urls) added += stmt.run(siteUrl, u, source, today).changes;
  return added;
}

export function markInspected(db, siteUrl, url, at) {
  db.prepare('UPDATE known_url SET last_inspected = ? WHERE site_url = ? AND url = ?').run(at, siteUrl, url);
}

export function insertInspection(db, siteUrl, insp) {
  db.prepare(`INSERT OR REPLACE INTO inspection (site_url, url, checked_at, verdict, coverage_state, indexing_state, robots_txt_state, last_crawl_time, google_canonical, user_canonical)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(siteUrl, insp.url, insp.checkedAt, insp.verdict ?? null, insp.coverageState ?? null, insp.indexingState ?? null,
      insp.robotsTxtState ?? null, insp.lastCrawlTime ?? null, insp.googleCanonical ?? null, insp.userCanonical ?? null);
}

/** Most recent stored inspection for a URL — call BEFORE inserting the new one. */
export function latestInspection(db, siteUrl, url) {
  const r = db.prepare('SELECT * FROM inspection WHERE site_url = ? AND url = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1').get(siteUrl, url);
  return r ? rowToInspection(r) : null;
}

export function insertRegression(db, siteUrl, detectedAt, reg) {
  return db.prepare(`INSERT OR IGNORE INTO regression (site_url, detected_at, type, subject, baseline, current, drop_pct, severity, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(siteUrl, detectedAt, reg.type, reg.subject, reg.baseline, reg.current, reg.dropPct, reg.severity, JSON.stringify(reg.details ?? {})).changes;
}

export function markNotified(db, ids, at) {
  const stmt = db.prepare('UPDATE regression SET notified_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(at, id);
}

// ── reads ───────────────────────────────────────────────────────────────────

export function siteDailyBetween(db, siteUrl, start, end) {
  return db.prepare('SELECT date, clicks, impressions, pages FROM site_daily WHERE site_url = ? AND date BETWEEN ? AND ? ORDER BY date').all(siteUrl, start, end);
}

export function pageWindow(db, siteUrl, start, end) {
  return db.prepare('SELECT page, clicks, impressions FROM page_window WHERE site_url = ? AND window_start = ? AND window_end = ?').all(siteUrl, start, end);
}

/** URLs due for inspection: never inspected first, then least-recently inspected. */
export function urlsDueForInspection(db, siteUrl, olderThan, limit) {
  return db.prepare(`SELECT url FROM known_url WHERE site_url = ? AND (last_inspected IS NULL OR last_inspected < ?)
    ORDER BY last_inspected IS NOT NULL, last_inspected ASC, first_seen ASC LIMIT ?`).all(siteUrl, olderThan, limit).map((r) => r.url);
}

export function pendingRegressions(db) {
  return db.prepare('SELECT * FROM regression WHERE notified_at IS NULL ORDER BY severity, detected_at').all().map(rowToRegression);
}

export function regressionsSince(db, since) {
  return db.prepare('SELECT * FROM regression WHERE detected_at >= ? ORDER BY detected_at DESC, severity').all(since).map(rowToRegression);
}

export function latestInspectionSummary(db, siteUrl) {
  return db.prepare(`SELECT verdict, COUNT(*) AS n FROM (
      SELECT url, verdict, MAX(checked_at) AS checked_at FROM inspection WHERE site_url = ? GROUP BY url
    ) GROUP BY verdict`).all(siteUrl);
}

export function knownUrlCount(db, siteUrl) {
  return db.prepare('SELECT COUNT(*) AS n FROM known_url WHERE site_url = ?').get(siteUrl).n;
}

function rowToInspection(r) {
  return { url: r.url, checkedAt: r.checked_at, verdict: r.verdict, coverageState: r.coverage_state, indexingState: r.indexing_state,
    robotsTxtState: r.robots_txt_state, lastCrawlTime: r.last_crawl_time, googleCanonical: r.google_canonical, userCanonical: r.user_canonical };
}

function rowToRegression(r) {
  return { id: r.id, siteUrl: r.site_url, detectedAt: r.detected_at, type: r.type, subject: r.subject, baseline: r.baseline, current: r.current,
    dropPct: r.drop_pct, severity: r.severity, details: JSON.parse(r.details), notifiedAt: r.notified_at };
}
