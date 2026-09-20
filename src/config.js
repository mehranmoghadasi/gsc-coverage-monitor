/**
 * config.js — load and validate gsc-monitor.json + environment.
 *
 * Nothing here talks to the network. Every default is documented in
 * gsc-monitor.example.json so a reviewer can see the knobs at a glance.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  analytics: Object.freeze({
    dataLagDays: 3, // GSC Search Analytics data is final ~2–3 days after the fact
    baselineDays: 28,
    recentDays: 7,
    siteDropThresholdPct: 25,
    pageMinBaselineImpressions: 20,
  }),
  inspection: Object.freeze({
    dailyBudget: 50, // URL Inspection quota is 2,000/day/property; stay well under
    recheckIntervalDays: 14,
  }),
  sitemaps: Object.freeze({
    submittedDropThresholdPct: 20,
  }),
});

const SITE_URL_RE = /^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s/]+\/.*)$/i;

/** Read a minimal .env file into process.env (no dependency on dotenv). */
export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * Merge a raw JSON object with DEFAULTS and validate it.
 * @param {object} raw
 * @returns {{properties: Array<{siteUrl:string,label:string,sitemaps:string[]}>, analytics: object, inspection: object, sitemaps: object}}
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  if (!Array.isArray(raw.properties) || raw.properties.length === 0) {
    throw new Error('config.properties must be a non-empty array');
  }
  const properties = raw.properties.map((p, i) => {
    if (!p || typeof p.siteUrl !== 'string' || !SITE_URL_RE.test(p.siteUrl)) {
      throw new Error(`properties[${i}].siteUrl must look like "sc-domain:example.com" or "https://example.com/"`);
    }
    return {
      siteUrl: p.siteUrl,
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : p.siteUrl,
      sitemaps: Array.isArray(p.sitemaps) ? p.sitemaps.filter((s) => typeof s === 'string') : [],
    };
  });
  const seen = new Set();
  for (const p of properties) {
    if (seen.has(p.siteUrl)) throw new Error(`duplicate property: ${p.siteUrl}`);
    seen.add(p.siteUrl);
  }
  const section = (name) => {
    const merged = { ...DEFAULTS[name], ...(raw[name] ?? {}) };
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${name}.${k} must be a non-negative number`);
    }
    return merged;
  };
  const cfg = { properties, analytics: section('analytics'), inspection: section('inspection'), sitemaps: section('sitemaps') };
  if (cfg.inspection.dailyBudget > 2000) throw new Error('inspection.dailyBudget cannot exceed the 2,000/day URL Inspection quota');
  if (cfg.analytics.recentDays >= cfg.analytics.baselineDays) throw new Error('analytics.recentDays must be smaller than baselineDays');
  return cfg;
}

/** Load config from disk (default ./gsc-monitor.json). */
export function loadConfig(path = process.env.GSC_MONITOR_CONFIG ?? 'gsc-monitor.json') {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`config not found: ${abs} (copy gsc-monitor.example.json to get started)`);
  return normalizeConfig(JSON.parse(readFileSync(abs, 'utf8')));
}

export function envSettings() {
  return {
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
    webhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
    dbPath: process.env.GSC_MONITOR_DB ?? './data/gsc-monitor.db',
  };
}
