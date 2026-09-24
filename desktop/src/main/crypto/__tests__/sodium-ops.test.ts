/**
 * F-1: the `sodium:*` IPC operation table is the boundary between the
 * sandboxed renderer and native libsodium in the main process. A compromised
 * renderer must not be able to call anything outside the table, smuggle
 * non-byte arguments, or push unbounded payloads; and the envelope must carry
 * TweetNaCl's error class/message back so the renderer contract is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { runSodiumOp, isSodiumOp, MAX_SYNC_ARG_BYTES } from '../sodium/ops';

const bytes = (n: number): Uint8Array => new Uint8Array(n);

describe('runSodiumOp — IPC boundary validation', () => {
  it('rejects unknown and prototype-chain op names', () => {
    for (const op of ['nope', '__proto__', 'constructor', 'toString', 42, null]) {
      expect(isSodiumOp(op)).toBe(false);
      expect(runSodiumOp(op, [], MAX_SYNC_ARG_BYTES)).toEqual({ ok: false, errorName: 'Error', message: 'unknown sodium op' });
    }
  });

  it('rejects non-array args and too many args', () => {
    expect(runSodiumOp('hmacSha256', 'x', MAX_SYNC_ARG_BYTES).ok).toBe(false);
    expect(runSodiumOp('hmacSha256', [1, 2, 3, 4, 5, 6], MAX_SYNC_ARG_BYTES).ok).toBe(false);
  });

  it('non-Uint8Array arguments come back as TweetNaCl-style TypeErrors', () => {
    expect(runSodiumOp('secretbox', [[1, 2], bytes(24), bytes(32)], MAX_SYNC_ARG_BYTES)).toEqual({
      ok: false,
      errorName: 'TypeError',
      message: 'unexpected type, use Uint8Array',
    });
    expect(runSodiumOp('secretbox', ['str', bytes(24), bytes(32)], MAX_SYNC_ARG_BYTES).ok).toBe(false);
  });

  it('enforces the payload bound', () => {
    const r = runSodiumOp('hmacSha256', [bytes(32), bytes(1025)], 1024);
    expect(r).toEqual({ ok: false, errorName: 'Error', message: 'sodium payload too large' });
  });

  it('bounds randomBytes and HKDF output lengths', () => {
    expect(runSodiumOp('randomBytes', [2 * 1024 * 1024], MAX_SYNC_ARG_BYTES).ok).toBe(false);
    expect(runSodiumOp('randomBytes', [-1], MAX_SYNC_ARG_BYTES).ok).toBe(false);
    expect(runSodiumOp('randomBytes', [1.5], MAX_SYNC_ARG_BYTES).ok).toBe(false);
    expect(runSodiumOp('hkdfSha256', [bytes(32), undefined, undefined, 255 * 32 + 1], MAX_SYNC_ARG_BYTES).ok).toBe(false);
    const ok = runSodiumOp('hkdfSha256', [bytes(32), undefined, undefined, 64], MAX_SYNC_ARG_BYTES);
    expect(ok.ok && (ok.value as Uint8Array).length).toBe(64);
  });

  it('carries primitive errors back with their message (never throws)', () => {
    expect(runSodiumOp('secretbox', [bytes(1), bytes(23), bytes(32)], MAX_SYNC_ARG_BYTES)).toEqual({
      ok: false,
      errorName: 'Error',
      message: 'bad nonce size',
    });
  });

  it('returns plain Uint8Arrays for byte results', () => {
    const r = runSodiumOp('hmacSha256', [bytes(32), bytes(3)], MAX_SYNC_ARG_BYTES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.getPrototypeOf(r.value)).toBe(Uint8Array.prototype);
  });
});
