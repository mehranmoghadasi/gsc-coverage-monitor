/**
 * Tests for the regression detection engine.
 */

import { describe, it, expect } from '@jest/globals';
import { detectRegression, computeHealthSummary, formatRegressionMessage } from '../src/lib/detector.js';

const OPTS = { threshold: 5, window: 7 };

// Helper to build a fake snapshot row
function snap(indexed, date = '2026-01-01') {
  return { site_url: 'https://example.com/', poll_date: date, indexed_urls: indexed, submitted_urls: indexed + 50 };
}

describe('detectRegression', () => {
  it('returns null when fewer than 3 snapshots exist', () => {
    const snapshots = [snap(1000), snap(980)];
    expect(detectRegression('https://example.com/', snapshots, OPTS)).toBeNull();
  });

  it('returns null when no drop exceeds threshold', () => {
    const snapshots = [snap(1000), snap(1010), snap(995), snap(990)];
    expect(detectRegression('https://example.com/', snapshots, OPTS)).toBeNull();
  });

  it('detects a drop at exactly the threshold', () => {
    // Baseline avg = 1000, current = 950 → 5% drop
    const snapshots = [snap(1000), snap(1000), snap(1000), snap(950)];
    const result = detectRegression('https://example.com/', snapshots, OPTS);
    expect(result).not.toBeNull();
    expect(result.dropPct).toBe(5);
    expect(result.type).toBe('threshold');
  });

  it('detects a significant drop well above threshold', () => {
    const snapshots = [snap(1000), snap(990), snap(1010), snap(700)]; // ~30% drop
    const result = detectRegression('https://example.com/', snapshots, OPTS);
    expect(result).not.toBeNull();
    expect(result.dropPct).toBeGreaterThan(25);
    expect(result.dropAbsolute).toBeGreaterThan(200);
  });

  it('detects total_loss type when indexed drops to 0', () => {
    const snapshots = [snap(500), snap(490), snap(510), snap(0)];
    const result = detectRegression('https://example.com/', snapshots, OPTS);
    expect(result).not.toBeNull();
    expect(result.type).toBe('total_loss');
    expect(result.dropPct).toBe(100);
    expect(result.currentIndexed).toBe(0);
  });

  it('returns null when baseline is 0 (avoids division by zero)', () => {
    const snapshots = [snap(0), snap(0), snap(0), snap(0)];
    expect(detectRegression('https://example.com/', snapshots, OPTS)).toBeNull();
  });
});

describe('computeHealthSummary', () => {
  it('computes correct totals across multiple properties', () => {
    const snapshots = [
      { siteUrl: 'https://a.com/', indexed_urls: 1000, submitted_urls: 1100, error_urls: 10 },
      { siteUrl: 'https://b.com/', indexed_urls: 500, submitted_urls: 600, error_urls: 5 },
    ];
    const summary = computeHealthSummary(snapshots);
    expect(summary.propertyCount).toBe(2);
    expect(summary.totalIndexed).toBe(1500);
    expect(summary.totalSubmitted).toBe(1700);
    expect(summary.totalErrors).toBe(15);
    // 1500/1700 ≈ 88.2%
    expect(summary.coverageRate).toBeCloseTo(88.2, 0);
  });

  it('handles empty snapshot list gracefully', () => {
    const summary = computeHealthSummary([]);
    expect(summary.propertyCount).toBe(0);
    expect(summary.totalIndexed).toBe(0);
    expect(summary.coverageRate).toBeNull();
  });
});

describe('formatRegressionMessage', () => {
  it('includes all key fields in the message', () => {
    const r = {
      siteUrl: 'https://example.com/',
      detectedDate: '2026-05-01',
      baselineAvg: 1000,
      currentIndexed: 900,
      dropPct: 10,
      dropAbsolute: 100,
      type: 'threshold',
    };
    const msg = formatRegressionMessage(r);
    expect(msg).toContain('example.com');
    expect(msg).toContain('1,000');
    expect(msg).toContain('900');
    expect(msg).toContain('10%');
  });
});
