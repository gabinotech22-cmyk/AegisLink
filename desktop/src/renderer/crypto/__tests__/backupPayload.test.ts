/**
 * Backup payload mappers — a restore must give the same account back.
 *
 * Contacts used to lose nickname, own relay, caps, pinned/hidden/pending and
 * profile on restore; groups and preferences were typed in the payload but
 * never written nor read. Lock settings must never be restored (no PIN hash
 * travels in the file → lock-out).
 */
import { describe, it, expect } from "vitest";
import { toBackupContact, toBackupGroup, restorablePreferences, RESTORABLE_PREFERENCE_KEYS } from '../backup';

describe('toBackupContact', () => {
  it('copies every persisted field, including the ones a restore used to lose', () => {
    const c = {
      aegisId: 'AAA-BBBB-CCCC', publicKeyB64: 'pk', signingPublicKeyB64: 'spk', name: 'Mamá', verified: true, addedAt: 1,
      color: '#abc', avatarImage: null, status: 'hola', muted: true, mutedUntil: 0, zeroTrust: true, blocked: false, archived: false,
      profileName: 'Carmen', nickname: 'Mamá', relayOnion: 'abc.onion', caps: ['sealed-calls'], pinned: true, hidden: false, pending: false, profile: 'work' as const,
    };
    const b = toBackupContact(c);
    expect(b).toEqual(c);
    // and back: the same object shape restores 1:1
    expect(toBackupContact(b)).toEqual(c);
  });
  it('normalizes absent optionals to null where the DB expects null', () => {
    const b = toBackupContact({ aegisId: 'A', publicKeyB64: 'p', name: 'n', verified: false, addedAt: 1 });
    expect(b.avatarImage).toBeNull();
    expect(b.mutedUntil).toBeNull();
    expect(b.nickname).toBeNull();
    expect(b.relayOnion).toBeNull();
    expect(b.caps).toBeNull();
  });
});

describe('toBackupGroup', () => {
  it('keeps the signed governance and roster state', () => {
    const g = {
      id: 'g1', name: 'Familia', members: ['A', 'B'], createdAt: 1, adminId: 'A', adminSig: 'sig', moderators: ['B'], admins: [],
      rosterVersion: 3, permissions: { invite: 'admins' }, govSig: 'gsig', govVersion: 2, pending: false, avatarColor: '#0f0',
    };
    expect(toBackupGroup(g)).toEqual(g);
    expect(toBackupGroup(g).members).not.toBe(g.members);
  });
});

describe('restorablePreferences', () => {
  it('drops lock settings and runtime flags, keeps data preferences', () => {
    const out = restorablePreferences({
      appLockEnabled: true, biometricsEnabled: true, lockTimeoutMin: 1, hideRecents: true, duressActive: true, hydrated: true,
      notifKeywords: ['x'], mutedChats: ['g1'], photoVis: 'none', themeDark: true, language: 'es',
    });
    expect(out).toEqual({ notifKeywords: ['x'], mutedChats: ['g1'], photoVis: 'none', themeDark: true, language: 'es' });
    expect(RESTORABLE_PREFERENCE_KEYS).not.toContain('appLockEnabled');
    expect(restorablePreferences(undefined)).toEqual({});
  });
});
