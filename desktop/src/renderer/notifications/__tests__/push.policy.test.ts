/**
 * Desktop notification policy (notifications/push.ts decideNotification) —
 * every switch of the Notifications screen, honoured. Pure, no Electron.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../i18n', () => ({ default: { t: (_k: string, d?: string) => d ?? _k } }));
import { decideNotification, matchesKeyword, totalUnreadFrom } from '../push';

const prefs = { notifMaster: true, notifPreview: false, notifSound: true, notifKeywords: ['urgente'] };
const base = { prefs, contact: {}, chatId: 'ALICE', activeChatId: null, windowFocused: false, senderName: 'Alice', body: 'hola', isGroup: false, now: 1_000 };

describe('decideNotification', () => {
  it('master off → nothing; a keyword still breaks through', () => {
    expect(decideNotification({ ...base, prefs: { ...prefs, notifMaster: false } })).toEqual({ show: false });
    expect(decideNotification({ ...base, prefs: { ...prefs, notifMaster: false }, body: 'es URGENTE' }).show).toBe(true);
  });

  it('muted contact ("always" or until-future) → nothing; expired mute → shows; muted group → nothing; keyword breaks through', () => {
    // utils/mute.ts: the flag is the source of truth, mutedUntil qualifies it
    // (0/null = always; a past deadline = expired). A timed mute used to never
    // expire here because the flag alone was enough.
    expect(decideNotification({ ...base, contact: { muted: true } })).toEqual({ show: false });
    expect(decideNotification({ ...base, contact: { muted: true, mutedUntil: 0 } })).toEqual({ show: false });
    expect(decideNotification({ ...base, contact: { muted: true, mutedUntil: 5_000 } })).toEqual({ show: false });
    expect(decideNotification({ ...base, contact: { muted: true, mutedUntil: 500 } }).show).toBe(true);
    expect(decideNotification({ ...base, contact: { mutedUntil: 5_000 } }).show).toBe(true);
    expect(decideNotification({ ...base, prefs: { ...base.prefs, mutedChats: [base.chatId] } })).toEqual({ show: false });
    expect(decideNotification({ ...base, prefs: { ...base.prefs, mutedChats: [base.chatId], mutedChatsUntil: { [base.chatId]: 500 } } }).show).toBe(true);
    expect(decideNotification({ ...base, contact: { muted: true }, body: 'urgente!' }).show).toBe(true);
  });

  it('the chat on screen with the window focused → nothing; unfocused window → shows', () => {
    expect(decideNotification({ ...base, activeChatId: 'ALICE', windowFocused: true })).toEqual({ show: false });
    expect(decideNotification({ ...base, activeChatId: 'ALICE', windowFocused: false }).show).toBe(true);
    expect(decideNotification({ ...base, activeChatId: 'BOB', windowFocused: true }).show).toBe(true);
  });

  it('previews OFF → generic title, empty body, preview=false (nothing identifying leaves the renderer)', () => {
    const d = decideNotification(base);
    expect(d).toEqual({ show: true, preview: false, title: 'AegisLink', body: '', silent: false });
  });

  it('previews ON → sender (or group · sender) and text; sound off → silent', () => {
    const p = { ...prefs, notifPreview: true, notifSound: false };
    expect(decideNotification({ ...base, prefs: p })).toEqual({ show: true, preview: true, title: 'Alice', body: 'hola', silent: true });
    const g = decideNotification({ ...base, prefs: p, isGroup: true, groupName: 'Equipo' });
    expect(g.show && g.title).toBe('Equipo · Alice');
  });

  it('previews ON → a media wire becomes its human label, the blob reference never leaves the renderer', () => {
    const p = { ...prefs, notifPreview: true };
    const d = decideNotification({ ...base, prefs: p, body: '[image:blob:9f1c:S3VrZXk=:bm9uY2U=:dG9rZW4=]mira' });
    expect(d.show).toBe(true);
    if (d.show) {
      expect(d.body).not.toContain('blob:');
      expect(d.body).not.toContain('S3VrZXk=');
    }
  });
});

describe('helpers', () => {
  it('matchesKeyword is case-insensitive and ignores blanks', () => {
    expect(matchesKeyword('Es Urgente', ['  urgente '])).toBe(true);
    expect(matchesKeyword('nada', ['', ' '])).toBe(false);
  });
  it('totalUnreadFrom sums positives only', () => {
    expect(totalUnreadFrom({ a: 2, b: 0, c: -1 })).toBe(2);
    expect(totalUnreadFrom(undefined)).toBe(0);
  });
});
