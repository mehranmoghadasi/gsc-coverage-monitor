/**
 * alerts.js — Alert dispatch: email via Nodemailer and CSV export
 *
 * Handles sending regression alerts by email and writing per-cycle
 * CSV alert files to the output directory.
 */

import nodemailer from 'nodemailer';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { format as formatCsv } from 'fast-csv';
import { formatRegressionMessage } from './detector.js';

/**
 * Send an email alert for one or more regressions.
 *
 * @param {object}     smtp         - SMTP configuration from config.js
 * @param {object[]}   regressions  - Array of Regression objects
 * @param {object}     summary      - Health summary object
 * @returns {Promise<void>}
 */
export async function sendEmailAlert(smtp, regressions, summary) {
  if (!smtp) {
    throw new Error('SMTP configuration is required to send email alerts.');
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 5_000,
  });

  const subject = regressions.length === 1
    ? `⚠️ GSC Coverage Alert: ${regressions[0].siteUrl}`
    : `⚠️ GSC Coverage Alerts (${regressions.length} properties)`;

  const textLines = [
    `GSC COVERAGE MONITOR — ${new Date().toISOString()}`,
    `Properties Monitored: ${summary.propertyCount}`,
    `Total Indexed: ${summary.totalIndexed.toLocaleString()} / ${summary.totalSubmitted.toLocaleString()} submitted (${summary.coverageRate ?? 'N/A'}%)`,
    '',
    '── REGRESSIONS DETECTED ──────────────────────────────',
    '',
    ...regressions.map(formatRegressionMessage),
    '',
    '── NEXT STEPS ────────────────────────────────────────',
    '1. Open Google Search Console for each flagged property.',
    '2. Check the Coverage → Index report for new errors or exclusions.',
    '3. Inspect affected URLs using the URL Inspection tool.',
    '4. Review recent site changes (deploys, robots.txt, canonical tags).',
  ];

  const htmlLines = [
    '<html><body style="font-family: monospace; font-size: 14px;">',
    `<h2>⚠️ GSC Coverage Monitor Alert</h2>`,
    `<p><strong>Date:</strong> ${new Date().toISOString()}</p>`,
    `<p><strong>Properties:</strong> ${summary.propertyCount} | <strong>Total Indexed:</strong> ${summary.totalIndexed.toLocaleString()} / ${summary.totalSubmitted.toLocaleString()} (${summary.coverageRate ?? 'N/A'}%)</p>`,
    '<hr>',
    ...regressions.map((r) => `
      <div style="background:#fff3cd;border:1px solid #ffc107;padding:12px;margin:8px 0;border-radius:4px;">
        <strong>${r.type === 'total_loss' ? '🚨 TOTAL LOSS' : '⚠️ DROP'} — ${r.siteUrl}</strong><br>
        Baseline avg: ${r.baselineAvg.toLocaleString()} → Current: ${r.currentIndexed.toLocaleString()}<br>
        <span style="color:red;font-weight:bold;">Drop: ${r.dropPct}% (−${r.dropAbsolute.toLocaleString()} URLs)</span>
      </div>`),
    '</body></html>',
  ];

  await transporter.sendMail({
    from: smtp.from,
    to: smtp.to,
    subject,
    text: textLines.join('\n'),
    html: htmlLines.join('\n'),
  });
}

/**
 * Write regression alerts to a CSV file in the output directory.
 *
 * @param {string}   outputDir   - Directory to write alert files
 * @param {object[]} regressions - Array of Regression objects
 * @param {string}   date        - YYYY-MM-DD date string for file naming
 * @returns {Promise<string>}    - Absolute path of the written CSV file
 */
export async function writeAlertCsv(outputDir, regressions, date) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filename = `gsc-alerts-${date}.csv`;
  const filePath = join(outputDir, filename);

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    const csvStream = formatCsv({ headers: true });

    csvStream.pipe(ws);

    for (const r of regressions) {
      csvStream.write({
        site_url: r.siteUrl,
        detected_date: r.detectedDate,
        type: r.type,
        baseline_avg: r.baselineAvg,
        current_indexed: r.currentIndexed,
        drop_pct: r.dropPct,
        drop_absolute: r.dropAbsolute,
      });
    }

    csvStream.end();

    ws.on('finish', () => resolve(filePath));
    ws.on('error', reject);
  });
}

/**
 * Write a daily health snapshot CSV (all properties, no regressions only).
 *
 * @param {string}   outputDir
 * @param {object[]} snapshots  - Latest snapshots array
 * @param {string}   date
 * @returns {Promise<string>}
 */
export async function writeSnapshotCsv(outputDir, snapshots, date) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filename = `gsc-snapshot-${date}.csv`;
  const filePath = join(outputDir, filename);

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    const csvStream = formatCsv({ headers: true });
    csvStream.pipe(ws);

    for (const s of snapshots) {
      csvStream.write({
        site_url: s.siteUrl ?? s.site_url,
        date: s.date ?? s.poll_date,
        submitted_urls: s.submittedUrls ?? s.submitted_urls,
        indexed_urls: s.indexedUrls ?? s.indexed_urls,
        error_urls: s.errorUrls ?? s.error_urls,
        warning_urls: s.warningUrls ?? s.warning_urls,
        excluded_urls: s.excludedUrls ?? s.excluded_urls,
        sitemap_count: s.sitemapCount ?? s.sitemap_count,
      });
    }

    csvStream.end();
    ws.on('finish', () => resolve(filePath));
    ws.on('error', reject);
  });
}
