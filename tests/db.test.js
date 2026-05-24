/**
 * Tests for the SQLite data layer.
 * Uses an in-memory database to avoid filesystem side effects.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import {
  upsertSnapshot,
  upsertSnapshots,
  getRecentSnapshots,
  getLatestSnapshots,
  insertRegression,
  getPendingRegressions,
  markRegressionAlerted,
  getSnapshotCounts,
} from '../src/lib/db.js';

// Open an in-memory DB and apply the same schema
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
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
  `);
  return db;
}

let db;
beforeEach(() => { db = createTestDb(); });
afterEach(() => { db.close(); });

const SITE = 'https://example.com/';

function makeSnap(indexed, date) {
  return { siteUrl: SITE, date, submittedUrls: indexed + 50, indexedUrls: indexed, errorUrls: 0, warningUrls: 0, excludedUrls: 50, sitemapCount: 1 };
}

describe('upsertSnapshot', () => {
  it('inserts a new snapshot', () => {
    upsertSnapshot(db, makeSnap(1000, '2026-05-01'));
    const row = db.prepare('SELECT * FROM snapshots WHERE poll_date = ?').get('2026-05-01');
    expect(row.indexed_urls).toBe(1000);
  });

  it('updates an existing snapshot for the same day', () => {
    upsertSnapshot(db, makeSnap(1000, '2026-05-01'));
    upsertSnapshot(db, makeSnap(950, '2026-05-01')); // Re-poll same day
    const rows = db.prepare('SELECT * FROM snapshots WHERE poll_date = ?').all('2026-05-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].indexed_urls).toBe(950);
  });
});

describe('upsertSnapshots (bulk)', () => {
  it('inserts multiple snapshots in a transaction', () => {
    const snaps = [makeSnap(1000, '2026-05-01'), makeSnap(990, '2026-05-02')];
    upsertSnapshots(db, snaps);
    const count = db.prepare('SELECT COUNT(*) as c FROM snapshots').get().c;
    expect(count).toBe(2);
  });
});

describe('getRecentSnapshots', () => {
  it('returns only snapshots within the day range', () => {
    upsertSnapshot(db, { ...makeSnap(1000, '2020-01-01') }); // too old
    upsertSnapshot(db, makeSnap(990, '2026-05-15'));
    const rows = getRecentSnapshots(db, SITE, 30);
    expect(rows.every((r) => r.poll_date >= '2026-04-16')).toBe(true);
  });
});

describe('getLatestSnapshots', () => {
  it('returns one row per site URL (most recent)', () => {
    upsertSnapshot(db, makeSnap(1000, '2026-05-01'));
    upsertSnapshot(db, makeSnap(990, '2026-05-02'));
    const rows = getLatestSnapshots(db, [SITE]);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexed_urls).toBe(990);
  });
});

describe('regressions', () => {
  it('inserts a regression and retrieves it as pending', () => {
    insertRegression(db, { siteUrl: SITE, detectedDate: '2026-05-16', baselineAvg: 1000, currentIndexed: 900, dropPct: 10 });
    const pending = getPendingRegressions(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].drop_pct).toBe(10);
  });

  it('marks a regression as alerted', () => {
    insertRegression(db, { siteUrl: SITE, detectedDate: '2026-05-16', baselineAvg: 1000, currentIndexed: 900, dropPct: 10 });
    const [row] = getPendingRegressions(db);
    markRegressionAlerted(db, row.id);
    const remaining = getPendingRegressions(db);
    expect(remaining).toHaveLength(0);
  });
});

describe('getSnapshotCounts', () => {
  it('returns counts per site URL', () => {
    upsertSnapshot(db, makeSnap(1000, '2026-05-01'));
    upsertSnapshot(db, makeSnap(990, '2026-05-02'));
    const counts = getSnapshotCounts(db);
    expect(counts).toHaveLength(1);
    expect(counts[0].count).toBe(2);
  });
});
