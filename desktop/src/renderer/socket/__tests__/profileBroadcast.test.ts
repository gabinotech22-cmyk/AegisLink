import { describe, test, expect } from 'vitest';
/**
 * profileBroadcast.test.ts — desktop phantom-notification dedup (pure core).
 *
 * Mirrors the mobile regression suite (mobile/src/socket/__tests__/
 * client.profileBroadcast.test.ts). The socket client module touches the
 * window.aegis preload bridge and is out of node-env vitest scope, so we test
 * the PURE fingerprint helpers it delegates to. Behaviour MUST match mobile
 * byte-for-byte so the same profile dedupes identically on both platforms.
 *
 * Background: a profile broadcast is a real E2EE envelope. To an OFFLINE contact
 * the relay queues it and fires the SAME generic wake-up push as a real message
 * — but on open there is nothing to show (profile_update applies silently).
 * Broadcasting on every auth:ok spammed every established contact with a phantom
 * notification on reconnect; the guard skips when the fingerprint is unchanged.
 */

import { profileFingerprint, profileBroadcastHashKey } from '../profileBroadcast';

/** Canonical form the client builds before hashing (order matters). */
function canonical(p: {
  senderName: string;
  senderColor: string;
  senderStatus: string;
  senderImage: string | null;
  deliveryTokenField?: Record<string, string>;
  mailboxRootField?: Record<string, string>;
}): string {
  return JSON.stringify({
    senderName: p.senderName,
    senderColor: p.senderColor,
    senderStatus: p.senderStatus,
    senderImage: p.senderImage,
    ...(p.deliveryTokenField ?? {}),
    ...(p.mailboxRootField ?? {}),
  });
}

const BASE = {
  senderName: 'Tester',
  senderColor: '#000',
  senderStatus: '',
  senderImage: null as string | null,
};

describe('profileFingerprint — phantom-notification dedup (desktop)', () => {
  test('is deterministic: same profile → same fingerprint (drives the skip)', () => {
    expect(profileFingerprint(canonical(BASE))).toBe(profileFingerprint(canonical(BASE)));
  });

  test('changes when the display name changes → re-broadcast', () => {
    const a = profileFingerprint(canonical(BASE));
    const b = profileFingerprint(canonical({ ...BASE, senderName: 'Tester-renamed' }));
    expect(a).not.toBe(b);
  });

  test('changes when the avatar color changes → re-broadcast', () => {
    const a = profileFingerprint(canonical(BASE));
    const b = profileFingerprint(canonical({ ...BASE, senderColor: '#fff' }));
    expect(a).not.toBe(b);
  });

  test('changes when the status changes → re-broadcast', () => {
    const a = profileFingerprint(canonical(BASE));
    const b = profileFingerprint(canonical({ ...BASE, senderStatus: 'busy' }));
    expect(a).not.toBe(b);
  });

  test('changes when the delivery token rotates → re-broadcast', () => {
    const a = profileFingerprint(canonical({ ...BASE, deliveryTokenField: { deliveryToken: 'tok1' } }));
    const b = profileFingerprint(canonical({ ...BASE, deliveryTokenField: { deliveryToken: 'tok2' } }));
    expect(a).not.toBe(b);
  });

  test('changes when the mailbox root rotates → re-broadcast', () => {
    const a = profileFingerprint(canonical({ ...BASE, mailboxRootField: { mailboxRoot: 'root1' } }));
    const b = profileFingerprint(canonical({ ...BASE, mailboxRootField: { mailboxRoot: 'root2' } }));
    expect(a).not.toBe(b);
  });

  test('output is a stable 8-char lowercase hex string', () => {
    const fp = profileFingerprint(canonical(BASE));
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  test('matches the mobile FNV-1a algorithm on a known vector (cross-platform parity)', () => {
    // Reference vector computed with the identical FNV-1a-32 implementation in
    // mobile/src/socket/client.ts. If this ever diverges, the two platforms would
    // dedupe differently and one could silently stop propagating a profile change.
    expect(profileFingerprint('aegis')).toBe('560edd4c');
  });
});

describe('profileBroadcastHashKey (desktop)', () => {
  test('is namespaced per identity', () => {
    expect(profileBroadcastHashKey('ABC-DEF1-GH23')).toBe('aegis.pbh.ABC-DEF1-GH23');
    expect(profileBroadcastHashKey('XYZ-1111-2222')).not.toBe(profileBroadcastHashKey('ABC-DEF1-GH23'));
  });
});
