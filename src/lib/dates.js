/** Small date helpers — all dates are ISO YYYY-MM-DD strings in UTC. */

export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/**
 * Compute the baseline and recent windows given the GSC data lag.
 * recent  = [today-lag-recentDays+1 … today-lag]
 * baseline = the `baselineDays` days immediately before the recent window.
 */
export function analyticsWindows(cfg, today = isoDate()) {
  const end = addDays(today, -cfg.dataLagDays);
  const recentStart = addDays(end, -(cfg.recentDays - 1));
  const baselineEnd = addDays(recentStart, -1);
  const baselineStart = addDays(baselineEnd, -(cfg.baselineDays - 1));
  return { baselineStart, baselineEnd, recentStart, recentEnd: end };
}
