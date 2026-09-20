/**
 * sampler.js — decide which URLs to spend today's URL Inspection budget on.
 *
 * Priority order:
 *   1. pages the analytics signal says vanished (most likely real problems)
 *   2. pages never inspected
 *   3. pages whose last inspection is older than recheckIntervalDays
 * Always de-duplicated and capped at the daily budget.
 */

/**
 * @param {string[]} vanished   subjects from vanishedPages()
 * @param {string[]} due        from db.urlsDueForInspection() (already ordered)
 * @param {number} budget
 */
export function pickInspectionSample(vanished, due, budget) {
  const out = [];
  const seen = new Set();
  for (const u of [...vanished, ...due]) {
    if (out.length >= budget) break;
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** URL Inspection requires the URL to belong to the property; filter out anything else. */
export function belongsToProperty(url, siteUrl) {
  try {
    const u = new URL(url);
    if (siteUrl.startsWith('sc-domain:')) {
      const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
      const host = u.hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    }
    return url.startsWith(siteUrl);
  } catch {
    return false;
  }
}
