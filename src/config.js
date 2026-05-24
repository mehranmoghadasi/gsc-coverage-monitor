/**
 * config.js — Configuration loader for gsc-coverage-monitor
 *
 * Reads from environment variables (loaded via dotenv) and an optional
 * JSON config file. Validates required fields and returns a typed config object.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import 'dotenv/config';

/**
 * @typedef {Object} PropertyConfig
 * @property {string} siteUrl    - GSC property URL, e.g. "https://example.com/" or "sc-domain:example.com"
 * @property {string} [label]   - Human-readable label for reports
 */

/**
 * @typedef {Object} AlertConfig
 * @property {boolean} email     - Send email alerts when regressions detected
 * @property {boolean} csv       - Export CSV alert file each poll cycle
 * @property {number}  threshold - % drop in indexed URLs that triggers a regression (default 5)
 * @property {number}  window    - Rolling average window in days (default 7)
 */

/**
 * @typedef {Object} SmtpConfig
 * @property {string} host
 * @property {number} port
 * @property {boolean} secure
 * @property {string} user
 * @property {string} pass
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} AppConfig
 * @property {PropertyConfig[]} properties
 * @property {AlertConfig}      alerts
 * @property {SmtpConfig|null}  smtp
 * @property {string}           dbPath
 * @property {string}           outputDir
 * @property {number}           lookbackDays  - Days of data to consider when polling
 */

/**
 * Load and validate application configuration.
 * Priority: config file > environment variables > defaults.
 *
 * @param {string} [configPath] - Optional path to JSON config file
 * @returns {AppConfig}
 */
export function loadConfig(configPath) {
  let fileConfig = {};

  const resolvedPath = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), 'gsc-monitor.config.json');

  if (existsSync(resolvedPath)) {
    try {
      const raw = readFileSync(resolvedPath, 'utf8');
      fileConfig = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse config file at ${resolvedPath}: ${err.message}`);
    }
  }

  // ── Properties ───────────────────────────────────────────────────────────
  const properties = fileConfig.properties ?? parsePropertiesFromEnv();
  if (!Array.isArray(properties) || properties.length === 0) {
    throw new Error(
      'No GSC properties configured. Set GSC_PROPERTIES in .env or provide a config file.'
    );
  }
  for (const p of properties) {
    if (!p.siteUrl || typeof p.siteUrl !== 'string') {
      throw new Error(`Each property must have a "siteUrl" string. Got: ${JSON.stringify(p)}`);
    }
  }

  // ── Alert settings ────────────────────────────────────────────────────────
  const alerts = {
    email: fileConfig.alerts?.email ?? (process.env.ALERT_EMAIL === 'true'),
    csv: fileConfig.alerts?.csv ?? (process.env.ALERT_CSV !== 'false'), // default on
    threshold: Number(fileConfig.alerts?.threshold ?? process.env.ALERT_THRESHOLD ?? 5),
    window: Number(fileConfig.alerts?.window ?? process.env.ALERT_WINDOW ?? 7),
  };

  // ── SMTP ──────────────────────────────────────────────────────────────────
  const smtp = (alerts.email || fileConfig.smtp)
    ? {
        host: fileConfig.smtp?.host ?? process.env.SMTP_HOST,
        port: Number(fileConfig.smtp?.port ?? process.env.SMTP_PORT ?? 587),
        secure: fileConfig.smtp?.secure ?? (process.env.SMTP_SECURE === 'true'),
        user: fileConfig.smtp?.user ?? process.env.SMTP_USER,
        pass: fileConfig.smtp?.pass ?? process.env.SMTP_PASS,
        from: fileConfig.smtp?.from ?? process.env.SMTP_FROM,
        to: fileConfig.smtp?.to ?? process.env.SMTP_TO,
      }
    : null;

  if (alerts.email && smtp) {
    for (const field of ['host', 'user', 'pass', 'from', 'to']) {
      if (!smtp[field]) {
        throw new Error(`SMTP field "${field}" is required when email alerts are enabled.`);
      }
    }
  }

  // ── Paths ─────────────────────────────────────────────────────────────────
  const dbPath = fileConfig.dbPath ?? process.env.DB_PATH ?? resolve(process.cwd(), 'gsc-monitor.db');
  const outputDir = fileConfig.outputDir ?? process.env.OUTPUT_DIR ?? resolve(process.cwd(), 'output');
  const lookbackDays = Number(fileConfig.lookbackDays ?? process.env.LOOKBACK_DAYS ?? 28);

  // ── Google auth ───────────────────────────────────────────────────────────
  const googleKeyFile = fileConfig.googleKeyFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!googleKeyFile) {
    throw new Error(
      'Google credentials not configured. Set GOOGLE_APPLICATION_CREDENTIALS in .env or provide googleKeyFile in the config.'
    );
  }

  return { properties, alerts, smtp, dbPath, outputDir, lookbackDays, googleKeyFile };
}

/**
 * Parse GSC_PROPERTIES env var into PropertyConfig[].
 * Format: comma-separated URLs, e.g. "https://a.com/,sc-domain:b.com"
 *
 * @returns {PropertyConfig[]}
 */
function parsePropertiesFromEnv() {
  const raw = process.env.GSC_PROPERTIES ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((siteUrl) => ({ siteUrl }));
}
