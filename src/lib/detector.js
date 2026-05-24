/**
 * detector.js — Coverage drift & regression detection engine
 *
 * Algorithm:
 *   1. Compute a rolling baseline (mean) of indexed URLs over the last N days
 *      (configurable window, default 7).
 *   2. Compare the most recent snapshot's indexed URL count against the baseline.
 *   3. If the drop exceeds the configured threshold (default 5%), flag as regression.
 *   4. Apply a minimum-history guard: at least 3 snapshots required to avoid
 *      false positives on brand-new properties.
 *   5. Emit structured regression objects for downstream alerting.
 */

/**
 * @typedef {Object} SnapshotRow
 * @property {string} site_url
 * @property {string} poll_date
 * @property {number} indexed_urls
 * @property {number} submitted_urls
 * @property {number} error_urls
 */

/**
 * @typedef {Object} Regression
 * @property {string} siteUrl
 * @property {string} detectedDate
 * @property {number} baselineAvg      - Mean indexed URL count over the window
 * @property {number} currentIndexed   - Today's indexed URL count
 * @property {number} dropPct          - Percentage drop (positive = drop)
 * @property {number} dropAbsolute     - Absolute URL count lost
 * @property {'threshold'|'total_loss'} type
 */

const MIN_SNAPSHOTS_REQUIRED = 3;

/**
 * Analyse a single property's historical snapshots and return any detected regression.
 *
 * @param {string}        siteUrl    - Property URL being analysed
 * @param {SnapshotRow[]} snapshots  - Ordered oldest-first, filtered to window period
 * @param {object}        opts
 * @param {number}        opts.threshold  - % drop that triggers a regression
 * @param {number}        opts.window     - Rolling window in days
 * @returns {Regression | null}
 */
export function detectRegression(siteUrl, snapshots, opts) {
  const { threshold } = opts;

  if (snapshots.length < MIN_SNAPSHOTS_REQUIRED) {
    return null; // Not enough history for meaningful comparison
  }

  // Baseline = average of all snapshots except the most recent
  const history = snapshots.slice(0, -1);
  const current = snapshots[snapshots.length - 1];

  const baselineAvg = history.reduce((sum, s) => sum + s.indexed_urls, 0) / history.length;

  if (baselineAvg === 0) {
    return null; // Avoid division-by-zero on brand-new or unindexed properties
  }

  const dropAbsolute = baselineAvg - current.indexed_urls;
  const dropPct = (dropAbsolute / baselineAvg) * 100;

  if (dropPct >= threshold) {
    return {
      siteUrl,
      detectedDate: current.poll_date,
      baselineAvg: Math.round(baselineAvg),
      currentIndexed: current.indexed_urls,
      dropPct: Math.round(dropPct * 10) / 10, // 1 decimal
      dropAbsolute: Math.round(dropAbsolute),
      type: 'threshold',
    };
  }

  // Secondary check: total loss (indexed_urls === 0 and history had > 0)
  if (current.indexed_urls === 0 && baselineAvg > 0) {
    return {
      siteUrl,
      detectedDate: current.poll_date,
      baselineAvg: Math.round(baselineAvg),
      currentIndexed: 0,
      dropPct: 100,
      dropAbsolute: Math.round(baselineAvg),
      type: 'total_loss',
    };
  }

  return null;
}

/**
 * Run regression detection across all properties.
 *
 * @param {object}                   db        - better-sqlite3 Database instance
 * @param {string[]}                 siteUrls  - All configured property URLs
 * @param {object}                   opts      - Detector options { threshold, window }
 * @param {Function}                 getRecent - (db, siteUrl, days) => SnapshotRow[]
 * @returns {Regression[]}
 */
export function detectAllRegressions(db, siteUrls, opts, getRecent) {
  const regressions = [];

  for (const siteUrl of siteUrls) {
    const snapshots = getRecent(db, siteUrl, opts.window + 1); // +1 for current day
    const regression = detectRegression(siteUrl, snapshots, opts);
    if (regression) {
      regressions.push(regression);
    }
  }

  return regressions;
}

/**
 * Compute portfolio-level coverage health summary across all properties.
 * Useful for the daily summary report even when no regressions are found.
 *
 * @param {object[]} latestSnapshots - Most recent snapshot per property
 * @returns {object}
 */
export function computeHealthSummary(latestSnapshots) {
  const total = latestSnapshots.length;
  const totalIndexed = latestSnapshots.reduce((s, r) => s + (r.indexed_urls ?? 0), 0);
  const totalSubmitted = latestSnapshots.reduce((s, r) => s + (r.submitted_urls ?? 0), 0);
  const totalErrors = latestSnapshots.reduce((s, r) => s + (r.error_urls ?? 0), 0);
  const coverageRate = totalSubmitted > 0
    ? Math.round((totalIndexed / totalSubmitted) * 1000) / 10
    : null;

  return {
    propertyCount: total,
    totalIndexed,
    totalSubmitted,
    totalErrors,
    coverageRate,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Format a regression into a human-readable alert message.
 *
 * @param {Regression} regression
 * @returns {string}
 */
export function formatRegressionMessage(regression) {
  const verb = regression.type === 'total_loss' ? '🚨 TOTAL LOSS' : '⚠️  DROP DETECTED';
  return [
    `${verb} — ${regression.siteUrl}`,
    `  Date:              ${regression.detectedDate}`,
    `  Baseline (avg):    ${regression.baselineAvg.toLocaleString()} indexed URLs`,
    `  Current:           ${regression.currentIndexed.toLocaleString()} indexed URLs`,
    `  Drop:              ${regression.dropPct}% (−${regression.dropAbsolute.toLocaleString()} URLs)`,
  ].join('\n');
}
