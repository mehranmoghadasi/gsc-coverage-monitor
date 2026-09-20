import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/lib/db.js';

test('regressions dedupe per day and pending/notified lifecycle works', () => {
  const d = db.openDatabase(':memory:');
  const reg = { type: 'page_vanished', subject: 'https://x.com/a', baseline: 10, current: 0, dropPct: 100, severity: 'high', details: { k: 1 } };
  assert.equal(db.insertRegression(d, 'sc-domain:x.com', '2026-09-19', reg), 1);
  assert.equal(db.insertRegression(d, 'sc-domain:x.com', '2026-09-19', reg), 0);
  const pending = db.pendingRegressions(d);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].details, { k: 1 });
  assert.equal(pending[0].dropPct, 100);
  db.markNotified(d, [pending[0].id], '2026-09-19T10:00:00Z');
  assert.equal(db.pendingRegressions(d).length, 0);
  assert.equal(db.regressionsSince(d, '2026-09-01').length, 1);
});

test('known URLs are due when never inspected, then by age', () => {
  const d = db.openDatabase(':memory:');
  db.addKnownUrls(d, 's', ['u1', 'u2', 'u3'], 'sitemap', '2026-09-01');
  db.markInspected(d, 's', 'u1', '2026-09-10T00:00:00Z');
  db.markInspected(d, 's', 'u2', '2026-08-01T00:00:00Z');
  assert.deepEqual(db.urlsDueForInspection(d, 's', '2026-09-05T00:00:00Z', 10), ['u3', 'u2']);
  assert.deepEqual(db.urlsDueForInspection(d, 's', '2026-09-05T00:00:00Z', 1), ['u3']);
});

test('inspection history returns the most recent record', () => {
  const d = db.openDatabase(':memory:');
  db.insertInspection(d, 's', { url: 'u', checkedAt: '2026-09-01T00:00:00Z', verdict: 'PASS', coverageState: 'Submitted and indexed' });
  db.insertInspection(d, 's', { url: 'u', checkedAt: '2026-09-15T00:00:00Z', verdict: 'NEUTRAL', coverageState: 'Excluded by noindex' });
  assert.equal(db.latestInspection(d, 's', 'u').verdict, 'NEUTRAL');
  assert.equal(db.latestInspection(d, 's', 'nope'), null);
  const summary = JSON.parse(JSON.stringify(db.latestInspectionSummary(d, 's')));
  assert.deepEqual(summary, [{ verdict: 'NEUTRAL', n: 1 }]);
});
