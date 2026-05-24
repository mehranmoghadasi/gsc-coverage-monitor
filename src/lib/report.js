/**
 * report.js — Terminal and text summary report generator
 *
 * Renders a formatted summary to stdout using chalk, and optionally
 * writes a plain-text version to the output directory.
 */

import chalk from 'chalk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { formatRegressionMessage } from './detector.js';

/**
 * Print a coloured summary table to stdout.
 *
 * @param {object[]} snapshots    - Latest snapshot per property
 * @param {object[]} regressions  - Detected regressions (may be empty)
 * @param {object}   summary      - Health summary from computeHealthSummary()
 */
export function printSummaryTable(snapshots, regressions, summary) {
  const divider = '─'.repeat(72);
  const now = new Date().toLocaleString('en-CA', { timeZone: 'America/Edmonton' });

  console.log('');
  console.log(chalk.bold.cyan(' GSC Coverage Monitor — Cycle Report'));
  console.log(chalk.gray(` ${now}`));
  console.log(chalk.gray(divider));

  // Portfolio header
  console.log(
    chalk.bold(' Properties: ') + chalk.white(summary.propertyCount) +
    chalk.bold('  |  Total Indexed: ') + chalk.white(summary.totalIndexed.toLocaleString()) +
    chalk.bold('  |  Coverage: ') +
    (summary.coverageRate >= 90
      ? chalk.green(`${summary.coverageRate}%`)
      : chalk.yellow(`${summary.coverageRate ?? 'N/A'}%`))
  );

  console.log(chalk.gray(divider));

  // Per-property rows
  for (const snap of snapshots) {
    const hasRegression = regressions.some(
      (r) => r.siteUrl === (snap.siteUrl ?? snap.site_url)
    );

    const label = snap.siteUrl ?? snap.site_url;
    const indexed = (snap.indexedUrls ?? snap.indexed_urls ?? 0).toLocaleString();
    const submitted = (snap.submittedUrls ?? snap.submitted_urls ?? 0).toLocaleString();
    const errors = snap.errorUrls ?? snap.error_urls ?? 0;

    const statusIcon = hasRegression
      ? chalk.red(' ✖ REGRESSION')
      : chalk.green(' ✔ OK');

    const errStr = errors > 0 ? chalk.yellow(`  ${errors} errors`) : '';

    console.log(` ${statusIcon}  ${chalk.bold(label)}`);
    console.log(`         Indexed: ${chalk.white(indexed)} / ${submitted} submitted${errStr}`);
  }

  console.log(chalk.gray(divider));

  if (regressions.length === 0) {
    console.log(chalk.green.bold(' ✔  No regressions detected this cycle.\n'));
  } else {
    console.log(chalk.red.bold(` ⚠  ${regressions.length} regression(s) detected:\n`));
    for (const r of regressions) {
      console.log(chalk.red(formatRegressionMessage(r)));
      console.log('');
    }
  }
}

/**
 * Write a plain-text cycle report to the output directory.
 *
 * @param {string}   outputDir
 * @param {object[]} snapshots
 * @param {object[]} regressions
 * @param {object}   summary
 * @param {string}   date       - YYYY-MM-DD
 * @returns {string}            - Path to written report
 */
export function writePlainReport(outputDir, snapshots, regressions, summary, date) {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const lines = [
    `GSC Coverage Monitor — Cycle Report`,
    `Date: ${date}`,
    `Properties: ${summary.propertyCount}  |  Total Indexed: ${summary.totalIndexed}  |  Coverage: ${summary.coverageRate ?? 'N/A'}%`,
    '',
    '── Property Snapshots ──────────────────────────────────────────────────',
    '',
  ];

  for (const snap of snapshots) {
    const label = snap.siteUrl ?? snap.site_url;
    const indexed = snap.indexedUrls ?? snap.indexed_urls ?? 0;
    const submitted = snap.submittedUrls ?? snap.submitted_urls ?? 0;
    const errors = snap.errorUrls ?? snap.error_urls ?? 0;
    lines.push(`${label}`);
    lines.push(`  Indexed: ${indexed.toLocaleString()} / ${submitted.toLocaleString()} submitted  |  Errors: ${errors}`);
    lines.push('');
  }

  if (regressions.length > 0) {
    lines.push('── Regressions ─────────────────────────────────────────────────────────');
    lines.push('');
    for (const r of regressions) {
      lines.push(formatRegressionMessage(r));
      lines.push('');
    }
  } else {
    lines.push('No regressions detected this cycle.');
  }

  const filename = `gsc-report-${date}.txt`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}
