/**
 * "Who sees my photo" — the policy every senderImage site applies.
 *
 * Before this module the Profile picker (all / contacts / nobody) governed
 * nothing: the photo went to everyone. Also pins the two wire semantics that
 * were wrong: `senderImage: null` is "no change" (a group receiver used to
 * treat it as "remove" and wiped the sender's photo on their second message),
 * and removal is the explicit `senderImageCleared` (removing your photo never
 * reached anyone).
 */
import { mayShareAvatar, avatarFieldsFor, receivedAvatar } from '../photoVisibility';

const IMG = 'data:image/jpeg;base64,AAAA';

describe('mayShareAvatar', () => {
  it('nobody → never', () => {
    expect(mayShareAvatar('none', { pending: false })).toBe(false);
    expect(mayShareAvatar('none', null)).toBe(false);
  });
  it('all → everyone, including non-contacts', () => {
    expect(mayShareAvatar('all', null)).toBe(true);
    expect(mayShareAvatar('all', { pending: true })).toBe(true);
  });
  it('contacts → only accepted, unblocked contacts in my list', () => {
    expect(mayShareAvatar('contacts', { pending: false })).toBe(true);
    expect(mayShareAvatar('contacts', { pending: true })).toBe(false);
    expect(mayShareAvatar('contacts', { blocked: true })).toBe(false);
    expect(mayShareAvatar('contacts', null)).toBe(false);
  });
});

describe('avatarFieldsFor', () => {
  it('sends the photo when allowed', () => {
    expect(avatarFieldsFor('all', null, IMG)).toEqual({ senderImage: IMG });
  });
  it('sends an explicit clear when denied or when we have no photo', () => {
    expect(avatarFieldsFor('none', { pending: false }, IMG)).toEqual({ senderImage: null, senderImageCleared: true });
    expect(avatarFieldsFor('contacts', null, IMG)).toEqual({ senderImage: null, senderImageCleared: true });
    expect(avatarFieldsFor('all', null, null)).toEqual({ senderImage: null, senderImageCleared: true });
  });
  it('repeats nothing once the recipient already got it this session', () => {
    expect(avatarFieldsFor('all', null, IMG, true)).toEqual({ senderImage: null });
    expect(avatarFieldsFor('none', null, IMG, true)).toEqual({ senderImage: null });
  });
});

describe('receivedAvatar', () => {
  it('null / absent = keep what we have', () => {
    expect(receivedAvatar({ senderImage: null })).toBeUndefined();
    expect(receivedAvatar({})).toBeUndefined();
    expect(receivedAvatar({ senderImage: '' })).toBeUndefined();
  });
  it('string = set, cleared = remove (even if a string is also present)', () => {
    expect(receivedAvatar({ senderImage: IMG })).toBe(IMG);
    expect(receivedAvatar({ senderImage: null, senderImageCleared: true })).toBeNull();
    expect(receivedAvatar({ senderImage: IMG, senderImageCleared: true })).toBeNull();
  });
});
