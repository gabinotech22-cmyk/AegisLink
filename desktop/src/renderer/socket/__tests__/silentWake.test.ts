import { describe, test, expect } from 'vitest';
/**
 * silentWake.test.ts — desktop parity of the mobile outbox.test.ts
 * "silent wake" cases: the same payload classes must be marked silent on both
 * platforms or one of them keeps producing phantom notifications.
 */
import { silentWakeHintFor } from '../silentWake';

describe('silentWakeHintFor (desktop)', () => {
  test('marks receipts, typing, profile, delete, key distribution and group control carriers silent', () => {
    for (const type of ['typing', 'read_receipt', 'msg_delete', 'sender_key_dist', 'profile_update']) {
      expect(silentWakeHintFor(JSON.stringify({ type, body: 'x' }))).toBe('silent');
    }
    for (const body of ['[group:meta]{}', '[group:dissolved]', '[group:left]']) {
      expect(silentWakeHintFor(JSON.stringify({ type: 'group_msg', body }))).toBe('silent');
    }
  });

  test('leaves real messages, group content and call signals alone', () => {
    expect(silentWakeHintFor(JSON.stringify({ type: 'direct_msg', body: 'hola' }))).toBeUndefined();
    expect(silentWakeHintFor(JSON.stringify({ type: 'group_msg', body: 'hola' }))).toBeUndefined();
    expect(silentWakeHintFor(JSON.stringify({ type: 'call_signal', body: '{}' }))).toBeUndefined();
    expect(silentWakeHintFor('not json')).toBeUndefined();
    expect(silentWakeHintFor(JSON.stringify({ body: 'no type' }))).toBeUndefined();
  });
});
