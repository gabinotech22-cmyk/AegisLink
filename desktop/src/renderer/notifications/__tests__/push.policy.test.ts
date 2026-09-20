/**
 * Desktop notification policy (notifications/push.ts decideNotification) —
 * every switch of the Notifications screen, honoured. Pure, no Electron.
 */
import { describe, it, expect } from 'vitest';
import { decideNotification, matchesKeyword, totalUnreadFrom } from '../push';

const prefs = { notifMaster: true, notifPreview: false, notifSound: true, notifKeywords: ['urgente'] };
const base = { prefs, contact: {}, chatId: 'ALICE', activeChatId: null, windowFocused: false, senderName: 'Alice', body: 'hola', isGroup: false, now: 1_000 };

describe('decideNotification', () => {
  it('master off → nothing; a keyword still breaks through', () => {
    expect(decideNotification({ ...base, prefs: { ...prefs, notifMaster: false } })).toEqual({ show: false });
    expect(decideNotification({ ...base, prefs: { ...prefs, notifMaster: false }, body: 'es URGENTE' }).show).toBe(true);
  });

  it('muted contact (flag or until-future) → nothing; expired mute → shows; keyword breaks through', () => {
    expect(decideNotification({ ...base, contact: { muted: true } })).toEqual({ show: false });
    expect(decideNotification({ ...base, contact: { mutedUntil: 5_000 } })).toEqual({ show: false });
    expect(decideNotification({ ...base, contact: { mutedUntil: 500 } }).show).toBe(true);
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
    expect(decideNotification({ ...base, prefs: p, isGroup: true, groupName: 'Equipo' }).title).toBe('Equipo · Alice');
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
