import { describe, test, expect } from 'vitest';
/**
 * spkRotation.test.ts — desktop B-3 age-based Signed PreKey rotation (pure core).
 *
 * Mirrors the mobile regression suite (mobile/src/socket/__tests__/
 * client.spkRotation.test.ts). The socket client module touches the window.aegis
 * preload bridge and is out of node-env vitest scope, so we test the PURE
 * decision/prune helpers it delegates to. Behaviour must match mobile exactly.
 */

import {
  spkRotationDecision,
  spkPruneTargetKeyId,
  SPK_ROTATION_INTERVAL_MS,
  SPK_RETAIN,
} from '../spkRotation';

const NOW = 1_750_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('B-3 — SPK rotation decision (desktop)', () => {
  test('rotates when the SPK is older than the interval', () => {
    const created = NOW - 8 * DAY_MS; // > 7 days
    expect(spkRotationDecision(created, NOW)).toEqual({ rotate: true, backfill: false });
  });

  test('does NOT rotate when the SPK is fresh', () => {
    const created = NOW - 60 * 60 * 1000; // 1 hour
    expect(spkRotationDecision(created, NOW)).toEqual({ rotate: false, backfill: false });
  });

  test('exactly at the interval boundary rotates (>=)', () => {
    const created = NOW - SPK_ROTATION_INTERVAL_MS;
    expect(spkRotationDecision(created, NOW).rotate).toBe(true);
  });

  test('one ms before the boundary does NOT rotate', () => {
    const created = NOW - SPK_ROTATION_INTERVAL_MS + 1;
    expect(spkRotationDecision(created, NOW).rotate).toBe(false);
  });

  test('a missing stamp (pre-B-3 install) backfills WITHOUT rotating', () => {
    expect(spkRotationDecision(null, NOW)).toEqual({ rotate: false, backfill: true });
  });
});

describe('B-3 — SPK prune boundary (desktop grace window)', () => {
  test('retains the last K=5 SPK secrets: keyId 6 prunes keyId 1', () => {
    expect(spkPruneTargetKeyId(6)).toBe(1); // 6 - 5
  });

  test('immediately-previous keyId is never the prune target (grace)', () => {
    // For keyId 6 we prune 1, so 5,4,3,2 (and 6) survive.
    expect(spkPruneTargetKeyId(6)).not.toBe(5);
  });

  test('nothing to prune until more than K SPKs exist', () => {
    expect(spkPruneTargetKeyId(1)).toBeNull();
    expect(spkPruneTargetKeyId(5)).toBeNull(); // 5 - 5 = 0 → below keyId 1
    expect(spkPruneTargetKeyId(6)).toBe(1);
  });

  test('K matches the documented retain constant', () => {
    expect(SPK_RETAIN).toBe(5);
    expect(spkPruneTargetKeyId(10)).toBe(10 - SPK_RETAIN);
  });
});
