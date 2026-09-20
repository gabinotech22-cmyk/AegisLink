/**
 * Mute semantics. Pins the two bugs: "mute always" (mutedUntil = 0) must mute
 * (mobile ignored it), and a timed mute must expire (desktop never let it).
 * Groups mute through preferences.mutedChats(+Until).
 */
import { describe, it, expect } from 'vitest';
import { isContactMutedNow, isChatMutedNow, withChatMute, muteActive } from '../mute';

const NOW = 1_700_000_000_000;

describe('contact mute', () => {
  it('"always" (mutedUntil 0 / null / undefined) mutes', () => {
    expect(isContactMutedNow({ muted: true, mutedUntil: 0 }, NOW)).toBe(true);
    expect(isContactMutedNow({ muted: true, mutedUntil: null }, NOW)).toBe(true);
    expect(isContactMutedNow({ muted: true }, NOW)).toBe(true);
  });
  it('a timed mute holds until its deadline and then expires', () => {
    expect(isContactMutedNow({ muted: true, mutedUntil: NOW + 1 }, NOW)).toBe(true);
    expect(isContactMutedNow({ muted: true, mutedUntil: NOW - 1 }, NOW)).toBe(false);
  });
  it('not muted when the flag is off, whatever the deadline says', () => {
    expect(isContactMutedNow({ muted: false, mutedUntil: NOW + 99 }, NOW)).toBe(false);
    expect(isContactMutedNow(null, NOW)).toBe(false);
  });
});

describe('chat (group) mute via preferences', () => {
  it('is off until something writes mutedChats', () => {
    expect(isChatMutedNow({ mutedChats: [] }, 'g1', NOW)).toBe(false);
  });
  it('withChatMute round-trips always and timed, and unmute clears both', () => {
    const always = withChatMute({ mutedChats: [] }, 'g1', true);
    expect(isChatMutedNow(always, 'g1', NOW)).toBe(true);
    expect(isChatMutedNow(always, 'g1', NOW + 10 ** 12)).toBe(true);

    const timed = withChatMute(always, 'g1', true, NOW + 3600_000);
    expect(timed.mutedChats).toEqual(['g1']);
    expect(isChatMutedNow(timed, 'g1', NOW)).toBe(true);
    expect(isChatMutedNow(timed, 'g1', NOW + 3600_001)).toBe(false);

    const off = withChatMute(timed, 'g1', false);
    expect(off.mutedChats).toEqual([]);
    expect(off.mutedChatsUntil).toEqual({});
  });
  it('muteActive: 0/null = forever', () => {
    expect(muteActive(0, NOW)).toBe(true);
    expect(muteActive(null, NOW)).toBe(true);
    expect(muteActive(NOW - 1, NOW)).toBe(false);
  });
});
