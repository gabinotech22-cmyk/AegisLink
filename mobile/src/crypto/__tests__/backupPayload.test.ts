/**
 * Backup payload mappers — a restore must give the same account back.
 *
 * Contacts used to lose nickname, own relay, caps, pinned/hidden/pending and
 * profile on restore; groups and preferences were typed in the payload but
 * never written nor read. Lock settings must never be restored (no PIN hash
 * travels in the file → lock-out).
 */
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

describe('toBackupMessage', () => {
  const { toBackupMessage } = require('../backup') as typeof import('../backup');
  const base = { id: 'm', chatId: 'c', direction: 'in' as const, createdAt: 1 };
  it('keeps text messages with their metadata', () => {
    const r = toBackupMessage({ ...base, body: 'hola', starred: true, senderId: 'S', replyToId: 'r', deliveryStatus: 'read' });
    expect(r).toMatchObject({ body: 'hola', starred: true, senderId: 'S', replyToId: 'r', deliveryStatus: 'read', deleted: false });
    expect(r?.attachment).toBeUndefined();
  });
  it('turns media into caption + attachment flag and never carries a wire tag', () => {
    expect(toBackupMessage({ ...base, body: 'mira', type: 'image', mediaUri: 'blob:id:KEY:n' })).toMatchObject({ body: 'mira', attachment: true });
    expect(toBackupMessage({ ...base, body: '[image:blob:id:KEY:n:t]' })).toMatchObject({ body: '', attachment: true });
    expect(toBackupMessage({ ...base, body: 'x', attachments: [{ uri: 'blob:a:K' }] })).toMatchObject({ attachment: true });
  });
  it('deleted rows lose their text; expired ephemerals are not backed up', () => {
    expect(toBackupMessage({ ...base, body: 'secret', deleted: true })).toMatchObject({ body: '', deleted: true });
    expect(toBackupMessage({ ...base, body: 'x', expiresAt: 1 })).toBeNull();
    expect(toBackupMessage({ ...base, body: 'x', expiresAt: Date.now() + 10 ** 9 })).not.toBeNull();
  });
});
