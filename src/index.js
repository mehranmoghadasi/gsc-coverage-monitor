#!/usr/bin/env node
/**
 * gsc-coverage-monitor — CLI entry point
 *
 * Commands:
 *   poll     Poll all configured GSC properties, store snapshots, detect regressions,
 *            dispatch alerts if configured.
 *   report   Print a summary of recent coverage data from the local database.
 *   list     List all GSC properties the configured account has access to.
 *   status   Show snapshot counts and the most recent poll date per property.
 *
 * Usage:
 *   node src/index.js poll [--config path/to/config.json]
 *   node src/index.js report [--days 30]
 *   node src/index.js list
 *   node src/index.js status
 */

import { program } from 'commander';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { createAuthClient, verifyAuth } from './lib/auth.js';
import { fetchAllSnapshots, listAccessibleProperties } from './lib/gsc.js';
import {
  openDatabase,
  upsertSnapshots,
  getRecentSnapshots,
  getLatestSnapshots,
  insertRegression,
  getPendingRegressions,
  markRegressionAlerted,
  getSnapshotCounts,
} from './lib/db.js';
import { detectAllRegressions, computeHealthSummary } from './lib/detector.js';
import { sendEmailAlert, writeAlertCsv, writeSnapshotCsv } from './lib/alerts.js';
import { printSummaryTable, writePlainReport } from './lib/report.js';

const PKG_VERSION = '1.0.0';

program
  .name('gsc-monitor')
  .description('Multi-property Google Search Console coverage drift monitor')
  .version(PKG_VERSION);

// ── poll ─────────────────────────────────────────────────────────────────────
program
  .command('poll')
  .description('Poll all configured GSC properties and detect coverage regressions')
  .option('-c, --config <path>', 'Path to JSON config file')
  .option('--dry-run', 'Fetch and analyse data but do not persist or alert')
  .action(async (opts) => {
    console.log(chalk.bold.cyan('\n🔍 GSC Coverage Monitor — Poll Cycle\n'));

    let config;
    try {
      config = loadConfig(opts.config);
    } catch (err) {
      console.error(chalk.red(`Config error: ${err.message}`));
      process.exit(1);
    }

    const auth = await createAuthClient(config.googleKeyFile);
    try {
      await verifyAuth(auth);
    } catch (err) {
      console.error(chalk.red(`Auth error: ${err.message}`));
      process.exit(1);
    }

    const siteUrls = config.properties.map((p) => p.siteUrl);
    console.log(chalk.gray(`Polling ${siteUrls.length} propert${siteUrls.length === 1 ? 'y' : 'ies'}...`));

    const snapshots = await fetchAllSnapshots(auth, siteUrls);
    const today = new Date().toISOString().slice(0, 10);

    if (!opts.dryRun) {
      const db = openDatabase(config.dbPath);
      upsertSnapshots(db, snapshots);
      console.log(chalk.gray(`Snapshots stored → ${config.dbPath}`));

      // Detect regressions
      const regressions = detectAllRegressions(
        db,
        siteUrls,
        { threshold: config.alerts.threshold, window: config.alerts.window },
        getRecentSnapshots
      );

      for (const r of regressions) {
        insertRegression(db, r);
      }

      const latestSnapshots = getLatestSnapshots(db, siteUrls);
      const summary = computeHealthSummary(latestSnapshots);

      printSummaryTable(latestSnapshots, regressions, summary);

      const pendingRegressions = getPendingRegressions(db);

      // CSV export
      if (config.alerts.csv) {
        const snapshotCsvPath = await writeSnapshotCsv(config.outputDir, snapshots, today);
        console.log(chalk.gray(`Snapshot CSV → ${snapshotCsvPath}`));

        if (pendingRegressions.length > 0) {
          const alertCsvPath = await writeAlertCsv(config.outputDir, pendingRegressions, today);
          console.log(chalk.yellow(`Alert CSV → ${alertCsvPath}`));
        }
      }

      // Report
      const reportPath = writePlainReport(config.outputDir, latestSnapshots, pendingRegressions, summary, today);
      console.log(chalk.gray(`Report → ${reportPath}`));

      // Email alerts
      if (config.alerts.email && pendingRegressions.length > 0) {
        try {
          await sendEmailAlert(config.smtp, pendingRegressions, summary);
          for (const r of pendingRegressions) {
            markRegressionAlerted(db, r.id);
          }
          console.log(chalk.yellow(`✉  Alert email sent to ${config.smtp.to}`));
        } catch (err) {
          console.error(chalk.red(`Email send failed: ${err.message}`));
        }
      }

      db.close();
    } else {
      // Dry-run: just print what would happen
      console.log(chalk.yellow('\n[dry-run] Snapshots fetched but not stored.\n'));
      for (const s of snapshots) {
        console.log(`  ${s.siteUrl}: ${s.indexedUrls ?? 'error'} indexed`);
      }
    }

    console.log(chalk.green('\n✔  Poll cycle complete.\n'));
  });

// ── report ────────────────────────────────────────────────────────────────────
program
  .command('report')
  .description('Print a coverage summary from stored snapshot data')
  .option('-c, --config <path>', 'Path to JSON config file')
  .option('--days <n>', 'Number of days of history to include', '30')
  .action(async (opts) => {
    let config;
    try {
      config = loadConfig(opts.config);
    } catch (err) {
      console.error(chalk.red(`Config error: ${err.message}`));
      process.exit(1);
    }

    const db = openDatabase(config.dbPath);
    const siteUrls = config.properties.map((p) => p.siteUrl);
    const latestSnapshots = getLatestSnapshots(db, siteUrls);

    if (latestSnapshots.length === 0) {
      console.log(chalk.yellow('\nNo snapshot data found. Run `gsc-monitor poll` first.\n'));
      db.close();
      return;
    }

    const summary = computeHealthSummary(latestSnapshots);
    const pendingRegressions = getPendingRegressions(db);
    printSummaryTable(latestSnapshots, pendingRegressions, summary);

    db.close();
  });

// ── list ──────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List all GSC properties accessible with the configured credentials')
  .option('-c, --config <path>', 'Path to JSON config file')
  .action(async (opts) => {
    let config;
    try {
      config = loadConfig(opts.config);
    } catch (err) {
      console.error(chalk.red(`Config error: ${err.message}`));
      process.exit(1);
    }

    const auth = await createAuthClient(config.googleKeyFile);
    const properties = await listAccessibleProperties(auth);

    if (properties.length === 0) {
      console.log(chalk.yellow('\nNo GSC properties found for this account.\n'));
      return;
    }

    console.log(chalk.bold.cyan('\nAccessible GSC Properties:\n'));
    for (const p of properties) {
      console.log(`  • ${p}`);
    }
    console.log('');
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show snapshot count and last poll date per property')
  .option('-c, --config <path>', 'Path to JSON config file')
  .action(async (opts) => {
    let config;
    try {
      config = loadConfig(opts.config);
    } catch (err) {
      console.error(chalk.red(`Config error: ${err.message}`));
      process.exit(1);
    }

    const db = openDatabase(config.dbPath);
    const counts = getSnapshotCounts(db);

    console.log(chalk.bold.cyan('\nSnapshot Status:\n'));
    if (counts.length === 0) {
      console.log(chalk.yellow('  No snapshots stored yet. Run `gsc-monitor poll` first.\n'));
    } else {
      for (const row of counts) {
        console.log(`  ${row.siteUrl}  →  ${row.count} snapshot(s)`);
      }
      console.log('');
    }
    db.close();
  });

program.parse(process.argv);
