/**
 * inviteLink — channel invite link build/parse (gap B, docs §11.2)
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { buildInviteLink, parseInviteLink, type ChannelInvite } from '../inviteLink';
import { generateChannelIdentity } from '../../crypto/publicChannelKey';

function freshInvite(opts: { capability?: Uint8Array | null; approvalGated?: boolean } = {}): ChannelInvite {
  const id = generateChannelIdentity();
  return {
    channelId: id.channelId,
    channelEd25519Pub: id.channelEd25519Pub,
    capability: opts.capability === undefined ? nacl.randomBytes(32) : opts.capability,
    approvalGated: opts.approvalGated ?? false,
  };
}

describe('buildInviteLink → parseInviteLink round-trip', () => {
  it('round-trips a capability-bearing (open) invite', () => {
    const invite = freshInvite();
    const url = buildInviteLink(invite);
    expect(url.startsWith('aegislink://channel/')).toBe(true);
    expect(url).toContain('?k=');

    const parsed = parseInviteLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.channelId).toBe(invite.channelId);
    expect(encodeBase64(parsed!.channelEd25519Pub)).toBe(encodeBase64(invite.channelEd25519Pub));
    expect(encodeBase64(parsed!.capability!)).toBe(encodeBase64(invite.capability!));
    expect(parsed!.approvalGated).toBe(false);
  });

  it('round-trips an approval-gated invite (no capability, p=1)', () => {
    const invite = freshInvite({ capability: null, approvalGated: true });
    const url = buildInviteLink(invite);
    expect(url).toContain('p=1');
    expect(url).not.toContain('k=');

    const parsed = parseInviteLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.capability).toBeNull();
    expect(parsed!.approvalGated).toBe(true);
    expect(parsed!.channelId).toBe(invite.channelId);
  });

  it('preserves exact bytes across many random keys', () => {
    for (let i = 0; i < 25; i++) {
      const invite = freshInvite();
      const parsed = parseInviteLink(buildInviteLink(invite));
      expect(parsed).not.toBeNull();
      expect(encodeBase64(parsed!.channelEd25519Pub)).toBe(encodeBase64(invite.channelEd25519Pub));
      expect(encodeBase64(parsed!.capability!)).toBe(encodeBase64(invite.capability!));
      expect(parsed!.channelId).toBe(invite.channelId);
    }
  });
});

describe('parseInviteLink rejects malformed input', () => {
  it('rejects a non-aegislink scheme', () => {
    expect(parseInviteLink('https://evil.com/channel/AAA/BBB')).toBeNull();
    expect(parseInviteLink('')).toBeNull();
    expect(parseInviteLink('aegislink://channel/onlyone')).toBeNull();
  });

  it('rejects an invalid base32 character', () => {
    const url = buildInviteLink(freshInvite());
    // Crockford excludes I/L/O/U — inject one into the id segment.
    const broken = url.replace('aegislink://channel/', 'aegislink://channel/U');
    expect(parseInviteLink(broken)).toBeNull();
  });

  it('rejects a wrong-length capability param', () => {
    const invite = freshInvite();
    const url = buildInviteLink(invite).replace(/\?k=.*/, '?k=ABC'); // too short
    expect(parseInviteLink(url)).toBeNull();
  });
});

describe('buildInviteLink validates inputs', () => {
  it('throws on a wrong-length pubkey', () => {
    const invite = freshInvite();
    expect(() => buildInviteLink({ ...invite, channelEd25519Pub: new Uint8Array(31) })).toThrow('pubkey must be 32 bytes');
  });
});
