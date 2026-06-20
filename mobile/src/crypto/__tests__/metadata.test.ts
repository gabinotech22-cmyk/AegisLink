/**
 * metadata.test.ts — security roadmap Ola 12 (MED: padding may miss the bucket
 * on UTF-8 input).
 *
 * The padding contract is: stripAndPad MUST return a buffer whose byte length is
 * EXACTLY one of the fixed buckets, so the encrypted wire length leaks nothing
 * about content. The previous iterative base64-pad scheme measured the bucket in
 * bytes but converged by trial; this locks the (now deterministic) guarantee and
 * specifically exercises multi-byte UTF-8, where char count != byte count would
 * break a naive implementation.
 */

import { stripAndPad, unpad, pickBucket } from '../metadata';

// Mirror of the bucket ladder in metadata.ts.
const BUCKETS = [
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
  262144, 1048576, 4194304,
];

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe('stripAndPad — exact bucket guarantee', () => {
  it('lands on an exact bucket for plain ASCII payloads', () => {
    const out = stripAndPad({ v: 2, from: 'AAA-BBBB-CCCC', ratchet: { x: 1 } });
    expect(BUCKETS).toContain(out.length);
  });

  it('lands on an exact bucket for multi-byte UTF-8 payloads', () => {
    // Each '😀' is 1 JS char-pair but 4 UTF-8 bytes; '€' is 3 bytes, 'ñ' is 2.
    // A char-count-based padder would overshoot/undershoot the bucket here.
    for (const fill of ['😀', '€', 'ñ', '中', '🔐🌍']) {
      for (let reps = 1; reps <= 400; reps += 37) {
        const out = stripAndPad({ v: 2, from: 'X', ratchet: { note: fill.repeat(reps) } });
        expect(BUCKETS).toContain(out.length);
      }
    }
  });

  it('always picks the SMALLEST bucket that fits (no needless inflation)', () => {
    for (let n = 0; n <= 4000; n += 13) {
      const payload = { v: 2, ratchet: { s: 'a'.repeat(n) } };
      const out = stripAndPad(payload);
      // The stripped JSON without filler must fit, and the next-smaller bucket
      // must NOT — i.e. out.length is exactly pickBucket(strippedByteLen).
      const strippedByteLen = byteLen(JSON.stringify({ v: 2, ratchet: { s: 'a'.repeat(n) } }));
      expect(out.length).toBe(pickBucket(strippedByteLen));
      expect(BUCKETS).toContain(out.length);
    }
  });

  it('produces a constant wire size for different content of the same bucket', () => {
    const a = stripAndPad({ v: 2, from: 'AAA-BBBB-CCCC', ratchet: { x: 1 } });
    const b = stripAndPad({ v: 2, from: 'ZZZ-9999-7777', ratchet: { x: 999, y: 'padme' } });
    expect(a.length).toBe(b.length);
  });
});

describe('stripAndPad / unpad — round-trip & field hygiene', () => {
  it('round-trips allow-listed fields and drops the (now absent) pad', () => {
    const padded = stripAndPad({ v: 2, from: 'X', ratchet: { y: 1 } });
    const restored = unpad(padded);
    expect(restored).not.toBeNull();
    expect(restored!.v).toBe(2);
    expect(restored!.from).toBe('X');
    expect(restored!.pad).toBeUndefined();
  });

  it('round-trips multi-byte UTF-8 content intact', () => {
    const note = '🔐 secreto — café ☕ 中文 😀';
    const restored = unpad(stripAndPad({ v: 2, ratchet: { note } }))!;
    expect((restored.ratchet as { note: string }).note).toBe(note);
  });

  it('strips disallowed metadata fields (timestamps, IPs, etc.)', () => {
    const restored = unpad(
      stripAndPad({
        v: 2,
        from: 'X',
        ratchet: {},
        timestamp: 123,
        ipAddress: '1.2.3.4',
        userAgent: 'leaky',
      } as Record<string, unknown>),
    )!;
    expect(restored.timestamp).toBeUndefined();
    expect(restored.ipAddress).toBeUndefined();
    expect(restored.userAgent).toBeUndefined();
  });
});
