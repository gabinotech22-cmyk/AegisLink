/**
 * store/channels — channels data layer (Phase 2d-1)
 *
 * Orchestration is tested with real crypto + service (so integrity is exercised
 * end-to-end) and mocked REST/transport/secret-store/contacts (so no network or
 * native modules are touched). Verifies: directory rejects unverified manifests,
 * sendPost seals + emits with no `from` and advances the head, loadFeed ingests
 * a verified chain, and live fan-out appends verified posts but drops forged ones.
 */

import nacl from 'tweetnacl';

jest.mock('../../api/publicChannels', () => ({
  listPublicChannels: jest.fn(),
  registerPublicChannel: jest.fn(async () => ({ channelId: 'x' })),
  getPublicChannelManifest: jest.fn(),
  setChannelAvatar: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../../channels/channelAvatarCache', () => ({
  uploadAvatarBlob: jest.fn(async () => 'mock-blob-id'),
  cacheLocalAvatar: jest.fn(async () => '/cached/avatar.jpg'),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../socket/publicChannels', () => ({
  pubchannelJoin: jest.fn(),
  pubchannelPost: jest.fn(),
  pubchannelPull: jest.fn(async () => ({ ok: true, posts: [] })),
  pubchannelTombstone: jest.fn(async () => ({ ok: true })),
  pubchannelApply: jest.fn(async () => ({ ok: true })),
  pubchannelPending: jest.fn(async () => ({ ok: true, pending: [] })),
  pubchannelApprove: jest.fn(async () => ({ ok: true })),
  pubchannelCheckApproval: jest.fn(async () => ({ ok: true, status: 'pending' })),
  pubchannelDelete: jest.fn(async () => ({ ok: true })),
  pubchannelBan: jest.fn(async () => ({ ok: true })),
  onPubchannelMsg: jest.fn(() => () => {}),
  onPubchannelDelete: jest.fn(() => () => {}),
  onPubchannelBan: jest.fn(() => () => {}),
  onPubchannelTombstone: jest.fn(() => () => {}),
}));
jest.mock('../../crypto/publicChannelStore', () => ({
  saveChannelSecrets: jest.fn(async () => {}),
  saveChannelSigningKey: jest.fn(async () => {}),
  getChannelCEK: jest.fn(),
  getChannelCapability: jest.fn(async () => null),
  getChannelSigningKey: jest.fn(async () => null),
  getChannelDeliveryToken: jest.fn(async () => 'tok'),
  isChannelOwned: jest.fn(async () => false),
  listChannelIds: jest.fn(async () => []),
  deleteChannel: jest.fn(async () => {}),
  saveJoinRequest: jest.fn(async () => {}),
  getJoinRequest: jest.fn(async () => null),
  listJoinRequests: jest.fn(async () => []),
  deleteJoinRequest: jest.fn(async () => {}),
  saveBannedMembers: jest.fn(async () => {}),
  getBannedMembers: jest.fn(async () => []),
}));
const mockContacts: Array<{ aegisId: string; signingPublicKeyB64: string }> = [];
jest.mock('../contacts', () => ({
  useContacts: { getState: () => ({ contacts: mockContacts }) },
}));

import { useChannels } from '../channels';
import * as api from '../../api/publicChannels';
import * as socket from '../../socket/publicChannels';
import * as store from '../../crypto/publicChannelStore';
import * as avatarCache from '../../channels/channelAvatarCache';
import {
  buildAndSealPost,
  type ChainHead,
} from '../../channels/channelService';
import {
  generateChannelIdentity,
  signManifest,
  type ChannelManifestData,
} from '../../crypto/publicChannelKey';
import { parseInviteLink } from '../../channels/inviteLink';
import type { Identity } from '../../crypto/identity';

const CHANNEL_ID = 'SKKk3vgfTWu1MxRtJYx6DA==';

const meKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const identity = {
  aegisId: 'AEGIS-ME',
  signingPublicKey: meKp.publicKey,
  signingSecretKey: meKp.secretKey,
} as unknown as Identity;

const cek = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

function sealAs(body: string, head: ChainHead | null) {
  return buildAndSealPost(CHANNEL_ID, { from: identity.aegisId, body, ts: 1750000000000 }, head, identity.signingSecretKey, cek);
}

function signedManifestBlob(name = 'My Channel', tamper = false): string {
  const id = generateChannelIdentity();
  const manifest: ChannelManifestData = {
    channelId: id.channelId, salt: id.salt, channelEd25519Pub: id.channelEd25519Pub,
    name, description: 'd', avatarHash: null, channelType: 0, createdAtHourMs: 1750000000000,
    manifestSeq: 1, contentKeyHash: null, delegationsHash: new Uint8Array(32),
    revokedHash: new Uint8Array(32), pinnedPostSeq: -1, discussionsEnabled: true,
  };
  const sig = signManifest(manifest, id.channelEd25519Secret);
  const { encodeBase64 } = require('tweetnacl-util');
  return JSON.stringify({
    channelId: id.channelId, salt: encodeBase64(id.salt), channelEd25519Pub: encodeBase64(id.channelEd25519Pub),
    sig: encodeBase64(sig), name: tamper ? 'Hacked' : name, description: 'd', avatarHash: null,
    channelType: 0, createdAtHourMs: 1750000000000, manifestSeq: 1, contentKeyHash: null,
    delegationsHash: encodeBase64(new Uint8Array(32)), revokedHash: encodeBase64(new Uint8Array(32)),
    pinnedPostSeq: -1, discussionsEnabled: true,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockContacts.length = 0;
  useChannels.setState({ directory: [], loadingDirectory: false, subscribed: [], hydrated: false, feeds: {}, heads: {}, pendingApplications: [], banned: {} });
  (store.getChannelCEK as jest.Mock).mockResolvedValue(cek);
  (store.getChannelDeliveryToken as jest.Mock).mockResolvedValue('tok');
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadDirectory', () => {
  it('keeps only channels whose manifest signature verifies', async () => {
    (api.listPublicChannels as jest.Mock).mockResolvedValue({
      channels: [
        { signed_manifest_blob: signedManifestBlob('Good') },
        { signed_manifest_blob: signedManifestBlob('Bad', true) }, // tampered after signing
      ],
    });
    await useChannels.getState().loadDirectory();

    const dir = useChannels.getState().directory;
    expect(dir).toHaveLength(1);
    expect(dir[0].name).toBe('Good');
    expect(useChannels.getState().loadingDirectory).toBe(false);
  });
});

describe('sendPost', () => {
  it('seals, emits without a `from`, appends optimistically and advances the head', async () => {
    (socket.pubchannelPost as jest.Mock).mockResolvedValue({ ok: true });

    const res = await useChannels.getState().sendPost(CHANNEL_ID, 'hello', identity);
    expect(res.ok).toBe(true);

    const call = (socket.pubchannelPost as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(CHANNEL_ID);          // channelId
    expect(typeof call[1]).toBe('string');     // ciphertext
    expect(typeof call[2]).toBe('string');     // nonce
    expect(call[3]).toBe('tok');               // deliveryToken
    expect(JSON.stringify(call)).not.toContain('AEGIS-ME'); // no sender id on the wire

    const feed = useChannels.getState().feeds[CHANNEL_ID];
    expect(feed.map((p) => p.body)).toEqual(['hello']);
    expect(useChannels.getState().heads[CHANNEL_ID]!.seqNum).toBe(0);
  });

  it('returns an error and does not append when the relay rejects', async () => {
    (socket.pubchannelPost as jest.Mock).mockResolvedValue({ ok: false, error: 'rate_limited' });
    const res = await useChannels.getState().sendPost(CHANNEL_ID, 'hi', identity);
    expect(res).toEqual({ ok: false, error: 'rate_limited' });
    expect(useChannels.getState().feeds[CHANNEL_ID]).toBeUndefined();
  });

  it('refuses to post to a channel we hold no key for', async () => {
    (store.getChannelCEK as jest.Mock).mockResolvedValue(null);
    const res = await useChannels.getState().sendPost(CHANNEL_ID, 'hi', identity);
    expect(res).toEqual({ ok: false, error: 'not_subscribed' });
  });
});

describe('loadFeed', () => {
  it('ingests a verified chain pulled from the relay', async () => {
    const p0 = sealAs('post 0', null);
    const p1 = sealAs('post 1', p0.newHead);
    (socket.pubchannelPull as jest.Mock).mockResolvedValue({
      ok: true,
      posts: [
        { seq_num: 0, ciphertext_b64: p0.wire.ciphertext, nonce_b64: p0.wire.nonce },
        { seq_num: 1, ciphertext_b64: p1.wire.ciphertext, nonce_b64: p1.wire.nonce },
      ],
    });

    await useChannels.getState().loadFeed(CHANNEL_ID, identity);

    const feed = useChannels.getState().feeds[CHANNEL_ID];
    expect(feed.map((p) => p.body)).toEqual(['post 0', 'post 1']);
    expect(useChannels.getState().heads[CHANNEL_ID]!.seqNum).toBe(1);
  });
});

describe('attachLive', () => {
  it('appends a verified live post and drops a forged one', async () => {
    let liveCb: ((e: unknown) => void) | null = null;
    (socket.onPubchannelMsg as jest.Mock).mockImplementation((cb: (e: unknown) => void) => {
      liveCb = cb;
      return () => {};
    });

    const off = useChannels.getState().attachLive(identity);
    expect(liveCb).not.toBeNull();

    // Valid sealed post at seq 0.
    const good = sealAs('live post', null);
    liveCb!({ channelId: CHANNEL_ID, seqNum: 0, ciphertext: good.wire.ciphertext, nonce: good.wire.nonce, createdAt: 1 });
    await flush();
    expect(useChannels.getState().feeds[CHANNEL_ID].map((p) => p.body)).toEqual(['live post']);

    // Forged post: random bytes won't decrypt → dropped, head unchanged.
    liveCb!({ channelId: CHANNEL_ID, seqNum: 1, ciphertext: 'Zm9yZ2Vk', nonce: 'bm9uY2U=', createdAt: 2 });
    await flush();
    expect(useChannels.getState().feeds[CHANNEL_ID]).toHaveLength(1);
    expect(useChannels.getState().heads[CHANNEL_ID]!.seqNum).toBe(0);

    off();
  });
});

describe('createChannel (gap C)', () => {
  it('registers a signed channel with a CEK envelope and returns a parseable invite', async () => {
    const res = await useChannels.getState().createChannel(
      { name: 'Aegis Notes', description: 'signed announcements', channelType: 'open' },
      identity,
    );
    expect(res.ok).toBe(true);
    expect(res.channelId).toBeDefined();
    expect(res.invite).toBeDefined();

    // Registration carries a signed blob + a non-empty wrapped CEK envelope.
    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    expect(typeof regArg.signedManifestBlob).toBe('string');
    expect(regArg.channelType).toBe('open');
    expect(JSON.parse(regArg.contentKeyEnvelope)).toHaveProperty('wrappedB64');

    // The invite carries this channel's id + a capability (open channel).
    const parsed = parseInviteLink(res.invite!);
    expect(parsed!.channelId).toBe(res.channelId);
    expect(parsed!.capability).not.toBeNull();

    // It is owned, and appears in the subscribed list.
    const sub = useChannels.getState().subscribed.find((c) => c.channelId === res.channelId);
    expect(sub).toMatchObject({ name: 'Aegis Notes', owned: true });
  });

  it('builds an approval-gated invite with no capability', async () => {
    const res = await useChannels.getState().createChannel(
      { name: 'Private', description: 'd', channelType: 'approval' },
      identity,
    );
    const parsed = parseInviteLink(res.invite!);
    expect(parsed!.approvalGated).toBe(true);
    expect(parsed!.capability).toBeNull();
  });
});

describe('joinViaInvite (gap D)', () => {
  it('full create → share → join handshake (manifest verify + CEK unwrap)', async () => {
    // Admin creates a channel; capture the blob + envelope the relay would store.
    const created = await useChannels.getState().createChannel(
      { name: 'OpSec', description: 'field notes', channelType: 'open' },
      identity,
    );
    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    (api.getPublicChannelManifest as jest.Mock).mockResolvedValue({ signed_manifest_blob: regArg.signedManifestBlob });
    (socket.pubchannelJoin as jest.Mock).mockResolvedValue({ ok: true, contentKeyEnvelope: regArg.contentKeyEnvelope });

    // A different user joins from the invite link.
    useChannels.setState({ subscribed: [] });
    const joiner = { aegisId: 'AEGIS-JOINER', signingPublicKey: meKp.publicKey, signingSecretKey: meKp.secretKey } as unknown as Identity;
    const res = await useChannels.getState().joinViaInvite(created.invite!, joiner);

    expect(res).toEqual({ ok: true, channelId: created.channelId });
    expect(useChannels.getState().subscribed.find((c) => c.channelId === created.channelId)).toMatchObject({ name: 'OpSec', owned: false });
  });

  it('rejects a malformed invite link', async () => {
    const res = await useChannels.getState().joinViaInvite('https://evil/x', identity);
    expect(res).toEqual({ ok: false, error: 'bad_invite' });
  });

  it('applies to an approval-gated invite (capability not in link) instead of joining', async () => {
    const created = await useChannels.getState().createChannel(
      { name: 'Gated', description: 'd', channelType: 'approval' },
      identity,
    );
    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    (api.getPublicChannelManifest as jest.Mock).mockResolvedValue({ signed_manifest_blob: regArg.signedManifestBlob });

    // A different user (not the owner) opens the invite link.
    useChannels.setState({ subscribed: [] });
    const res = await useChannels.getState().joinViaInvite(created.invite!, identity);

    // Phase 4: the client applies with a fresh ephemeral key and waits for the
    // owner's approval — it must NOT be subscribed yet.
    expect(res).toEqual({ ok: true, applied: true, channelId: created.channelId });
    expect(socket.pubchannelApply).toHaveBeenCalledWith(created.channelId, expect.any(String));
    expect(store.saveJoinRequest).toHaveBeenCalledWith(expect.objectContaining({ channelId: created.channelId, name: 'Gated' }));
    expect(useChannels.getState().pendingApplications).toEqual([
      expect.objectContaining({ channelId: created.channelId, name: 'Gated' }),
    ]);
    expect(useChannels.getState().subscribed.find((c) => c.channelId === created.channelId)).toBeUndefined();
  });

  it('a failed apply rolls back the stored join request', async () => {
    const created = await useChannels.getState().createChannel(
      { name: 'GatedFail', description: 'd', channelType: 'approval' },
      identity,
    );
    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    (api.getPublicChannelManifest as jest.Mock).mockResolvedValue({ signed_manifest_blob: regArg.signedManifestBlob });
    (socket.pubchannelApply as jest.Mock).mockResolvedValueOnce({ ok: false, error: 'pending_full' });

    const res = await useChannels.getState().joinViaInvite(created.invite!, identity);

    expect(res).toEqual({ ok: false, error: 'pending_full' });
    expect(store.deleteJoinRequest).toHaveBeenCalledWith(created.channelId);
    expect(useChannels.getState().pendingApplications).toEqual([]);
  });

  it('rejects when the unwrapped CEK does not match the manifest contentKeyHash', async () => {
    const created = await useChannels.getState().createChannel(
      { name: 'Tampered', description: 'd', channelType: 'open' },
      identity,
    );
    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    (api.getPublicChannelManifest as jest.Mock).mockResolvedValue({ signed_manifest_blob: regArg.signedManifestBlob });
    // Relay returns an envelope wrapping a DIFFERENT CEK → unwrap succeeds but the
    // contentKeyHash check must fail.
    const parsed = parseInviteLink(created.invite!)!;
    const { wrapCEK } = require('../../crypto/publicChannelKey') as typeof import('../../crypto/publicChannelKey');
    const wrongEnvelope = JSON.stringify(wrapCEK(new Uint8Array(32).fill(9), parsed.capability!, created.channelId!));
    (socket.pubchannelJoin as jest.Mock).mockResolvedValue({ ok: true, contentKeyEnvelope: wrongEnvelope });

    const res = await useChannels.getState().joinViaInvite(created.invite!, identity);
    expect(res).toEqual({ ok: false, error: 'cek_mismatch' });
  });
});

describe('removeChannel (leave)', () => {
  it('removes the channel from subscribed, feeds, heads and wipes secrets', async () => {
    // Seed state with a subscribed channel + feed + head.
    useChannels.setState({
      subscribed: [{ channelId: CHANNEL_ID, name: 'Leaving', description: '', channelType: 'open', owned: false, avatarHash: null, channelEd25519PubB64: null }],
      feeds: { [CHANNEL_ID]: [{ id: `${CHANNEL_ID}:0`, from: 'A', body: 'hi', senderName: null, ts: 1, seqNum: 0 }] },
      heads: { [CHANNEL_ID]: { seqNum: 0, postHash: new Uint8Array(32) } },
    });

    await useChannels.getState().removeChannel(CHANNEL_ID);

    expect(useChannels.getState().subscribed).toHaveLength(0);
    expect(useChannels.getState().feeds[CHANNEL_ID]).toBeUndefined();
    expect(useChannels.getState().heads[CHANNEL_ID]).toBeUndefined();
    expect(store.deleteChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });
});

describe('tombstone (delete channel with valid signature)', () => {
  it('signTombstone produces a valid signature that verifyTombstone accepts', () => {
    const { signTombstone, verifyTombstone, generateChannelIdentity } = require('../../crypto/publicChannelKey') as typeof import('../../crypto/publicChannelKey');
    const ch = generateChannelIdentity();
    const ts = Date.now();
    const sig = signTombstone(ch.channelId, ts, ch.channelEd25519Secret);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(verifyTombstone(ch.channelId, ts, sig, ch.channelEd25519Pub)).toBe(true);
    // Wrong timestamp must fail
    expect(verifyTombstone(ch.channelId, ts + 1, sig, ch.channelEd25519Pub)).toBe(false);
  });
});

describe('createChannel with avatar (Slice 2)', () => {
  const fakeAvatarHash = new Uint8Array(32).fill(0xab);

  it('sets avatarHash non-null in the manifest when avatar is provided', async () => {
    const res = await useChannels.getState().createChannel(
      {
        name: 'WithAvatar',
        description: 'has a photo',
        channelType: 'open',
        avatarUri: 'file:///mock/avatar.jpg',
        avatarHash: fakeAvatarHash,
      },
      identity,
    );
    expect(res.ok).toBe(true);

    // The signed manifest blob must contain the avatarHash (non-null).
    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    const manifestBlob = JSON.parse(regArg.signedManifestBlob) as { avatarHash: string | null };
    expect(manifestBlob.avatarHash).not.toBeNull();
    expect(typeof manifestBlob.avatarHash).toBe('string');

    // Avatar upload should have been attempted.
    expect(avatarCache.uploadAvatarBlob).toHaveBeenCalledWith('file:///mock/avatar.jpg');
    expect(api.setChannelAvatar).toHaveBeenCalled();
    expect(avatarCache.cacheLocalAvatar).toHaveBeenCalled();

    // The subscribed entry should carry the avatarHash.
    const sub = useChannels.getState().subscribed.find((c) => c.channelId === res.channelId);
    expect(sub?.avatarHash).toEqual(fakeAvatarHash);
  });

  it('sets avatarHash null when no avatar is provided', async () => {
    const res = await useChannels.getState().createChannel(
      { name: 'NoAvatar', description: 'd', channelType: 'readonly' },
      identity,
    );
    expect(res.ok).toBe(true);

    const regArg = (api.registerPublicChannel as jest.Mock).mock.calls[0][0];
    const manifestBlob = JSON.parse(regArg.signedManifestBlob) as { avatarHash: string | null };
    expect(manifestBlob.avatarHash).toBeNull();

    // Avatar upload should NOT have been attempted.
    expect(avatarCache.uploadAvatarBlob).not.toHaveBeenCalled();
  });

  it('still creates the channel even if avatar upload fails', async () => {
    (avatarCache.uploadAvatarBlob as jest.Mock).mockRejectedValueOnce(new Error('network'));

    const res = await useChannels.getState().createChannel(
      {
        name: 'FailAvatar',
        description: 'd',
        channelType: 'open',
        avatarUri: 'file:///mock/fail.jpg',
        avatarHash: fakeAvatarHash,
      },
      identity,
    );
    // Channel creation succeeds despite avatar failure.
    expect(res.ok).toBe(true);
    expect(res.channelId).toBeDefined();
    expect(useChannels.getState().subscribed.find((c) => c.channelId === res.channelId)).toBeDefined();
  });
});

describe('createChannel — duplicate guard + failure feedback (prod dupes 2026-07-02)', () => {
  it('refuses to create a second owned channel with the same name', async () => {
    const first = await useChannels.getState().createChannel(
      { name: 'testers', description: 'd', channelType: 'open' },
      identity,
    );
    expect(first.ok).toBe(true);
    (api.registerPublicChannel as jest.Mock).mockClear();

    // Same name modulo whitespace/case — the classic re-tap after a silent failure.
    const second = await useChannels.getState().createChannel(
      { name: '  Testers ', description: 'd', channelType: 'open' },
      identity,
    );
    expect(second).toEqual({ ok: false, error: 'duplicate_name' });
    expect(api.registerPublicChannel).not.toHaveBeenCalled();
  });

  it('does not block joined (non-owned) channels with the same name', async () => {
    useChannels.setState({
      subscribed: [{ channelId: 'other', name: 'testers', description: '', channelType: 'open', owned: false, avatarHash: null, channelEd25519PubB64: null }],
    });
    const res = await useChannels.getState().createChannel(
      { name: 'testers', description: 'd', channelType: 'open' },
      identity,
    );
    expect(res.ok).toBe(true);
  });

  it('returns an error (never throws) and tombstones the orphan when local persistence fails after registration', async () => {
    (store.saveChannelSecrets as jest.Mock).mockRejectedValueOnce(new Error('secure_store_unavailable'));

    const res = await useChannels.getState().createChannel(
      { name: 'orphan', description: 'd', channelType: 'open' },
      identity,
    );

    // The relay call happened, but the result is a UI-visible error, not a throw.
    expect(api.registerPublicChannel).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('secure_store_unavailable');
    // Best-effort rollback: the half-created channel is tombstoned off the directory.
    expect(socket.pubchannelTombstone).toHaveBeenCalledTimes(1);
    // And it never enters the local subscribed list.
    expect(useChannels.getState().subscribed).toHaveLength(0);
  });
});

describe('hydrateSubscribed (restore after app restart)', () => {
  /** A real signed manifest whose channelId we can feed into the mocked index. */
  function makeChannel(name: string) {
    const id = generateChannelIdentity();
    const manifest: ChannelManifestData = {
      channelId: id.channelId, salt: id.salt, channelEd25519Pub: id.channelEd25519Pub,
      name, description: 'restored desc', avatarHash: null, channelType: 0, createdAtHourMs: 1750000000000,
      manifestSeq: 1, contentKeyHash: null, delegationsHash: new Uint8Array(32),
      revokedHash: new Uint8Array(32), pinnedPostSeq: -1, discussionsEnabled: true,
    };
    const sig = signManifest(manifest, id.channelEd25519Secret);
    const { encodeBase64 } = require('tweetnacl-util');
    const blob = JSON.stringify({
      channelId: id.channelId, salt: encodeBase64(id.salt), channelEd25519Pub: encodeBase64(id.channelEd25519Pub),
      sig: encodeBase64(sig), name, description: 'restored desc', avatarHash: null,
      channelType: 0, createdAtHourMs: 1750000000000, manifestSeq: 1, contentKeyHash: null,
      delegationsHash: encodeBase64(new Uint8Array(32)), revokedHash: encodeBase64(new Uint8Array(32)),
      pinnedPostSeq: -1, discussionsEnabled: true,
    });
    return { channelId: id.channelId, blob, pubB64: encodeBase64(id.channelEd25519Pub) as string };
  }

  it('rebuilds subscribed from the secret index + verified manifests (with pubkey + description)', async () => {
    const ch = makeChannel('Restored');
    (store.listChannelIds as jest.Mock).mockResolvedValue([ch.channelId]);
    (store.isChannelOwned as jest.Mock).mockResolvedValue(true);
    (api.getPublicChannelManifest as jest.Mock).mockResolvedValue({ signed_manifest_blob: ch.blob });

    await useChannels.getState().hydrateSubscribed();

    const subs = useChannels.getState().subscribed;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      channelId: ch.channelId,
      name: 'Restored',
      description: 'restored desc',
      owned: true,
      channelEd25519PubB64: ch.pubB64,
    });
    expect(useChannels.getState().hydrated).toBe(true);
  });

  it('never trusts a manifest that fails signature verification', async () => {
    const ch = makeChannel('Legit');
    const tampered = ch.blob.replace('Legit', 'Fake!'); // breaks the signature
    (store.listChannelIds as jest.Mock).mockResolvedValue([ch.channelId]);
    (api.getPublicChannelManifest as jest.Mock).mockResolvedValue({ signed_manifest_blob: tampered });

    await useChannels.getState().hydrateSubscribed();

    expect(useChannels.getState().subscribed).toHaveLength(0);
    expect(useChannels.getState().hydrated).toBe(true);
  });

  it('keeps secrets and skips the channel when the manifest fetch fails (offline)', async () => {
    (store.listChannelIds as jest.Mock).mockResolvedValue(['some-channel']);
    (api.getPublicChannelManifest as jest.Mock).mockRejectedValue(new Error('network'));

    await expect(useChannels.getState().hydrateSubscribed()).resolves.toBeUndefined();

    expect(useChannels.getState().subscribed).toHaveLength(0);
    expect(store.deleteChannel).not.toHaveBeenCalled(); // NEVER wipe keys on a flaky network
  });

  it('does not duplicate channels already in the subscribed list', async () => {
    const ch = makeChannel('Dup');
    useChannels.setState({
      subscribed: [{ channelId: ch.channelId, name: 'Dup', description: '', channelType: 'open', owned: false, avatarHash: null, channelEd25519PubB64: null }],
    });
    (store.listChannelIds as jest.Mock).mockResolvedValue([ch.channelId]);

    await useChannels.getState().hydrateSubscribed();

    expect(useChannels.getState().subscribed).toHaveLength(1);
    expect(api.getPublicChannelManifest).not.toHaveBeenCalled();
  });
});

describe('member ban (issue #207 — owner moderation, docs §10.4)', () => {
  const { encodeBase64 } = require('tweetnacl-util') as typeof import('tweetnacl-util');
  const { verifyBan } = require('../../crypto/publicChannelKey') as typeof import('../../crypto/publicChannelKey');

  const eveKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  const eve = 'AEGIS-EVE';

  function seedOwnedChannel(channelSecret: Uint8Array, channelPub: Uint8Array) {
    (store.getChannelSigningKey as jest.Mock).mockResolvedValue(channelSecret);
    useChannels.setState({
      subscribed: [{
        channelId: CHANNEL_ID, name: 'Mine', description: '', channelType: 'open',
        owned: true, avatarHash: null, channelEd25519PubB64: encodeBase64(channelPub),
      }],
      feeds: {
        [CHANNEL_ID]: [
          { id: `${CHANNEL_ID}:0`, from: identity.aegisId, body: 'mine', senderName: null, ts: 1, seqNum: 0 },
          { id: `${CHANNEL_ID}:1`, from: eve, body: 'spam', senderName: null, ts: 2, seqNum: 1 },
        ],
      },
    });
  }

  it('banMember signs a verifiable ban record, emits it and purges the member from the feed', async () => {
    const ch = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    seedOwnedChannel(ch.secretKey, ch.publicKey);

    const res = await useChannels.getState().banMember(CHANNEL_ID, eve);
    expect(res).toEqual({ ok: true });

    // Wire: signed record the relay can verify against the stored manifest key.
    const [chanArg, recordStr, sigB64] = (socket.pubchannelBan as jest.Mock).mock.calls[0] as [string, string, string];
    expect(chanArg).toBe(CHANNEL_ID);
    const record = JSON.parse(recordStr) as { banned: string; ts: number; channelId: string };
    expect(record).toMatchObject({ banned: eve, channelId: CHANNEL_ID });
    const { decodeBase64 } = require('tweetnacl-util') as typeof import('tweetnacl-util');
    expect(verifyBan(CHANNEL_ID, recordStr, decodeBase64(sigB64), ch.publicKey)).toBe(true);

    // Local enforcement: banned member disappears from the feed, list persisted.
    expect(useChannels.getState().banned[CHANNEL_ID]).toEqual([eve]);
    expect(useChannels.getState().feeds[CHANNEL_ID].map((p) => p.from)).toEqual([identity.aegisId]);
    expect(store.saveBannedMembers).toHaveBeenCalledWith(CHANNEL_ID, [eve]);
  });

  it('banMember refuses when we do not hold the channel signing key', async () => {
    (store.getChannelSigningKey as jest.Mock).mockResolvedValue(null);
    const res = await useChannels.getState().banMember(CHANNEL_ID, eve);
    expect(res).toEqual({ ok: false, error: 'not_owner' });
    expect(socket.pubchannelBan).not.toHaveBeenCalled();
  });

  it('a received ban with a valid signature filters the member; a forged one is ignored', async () => {
    const ch = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    seedOwnedChannel(new Uint8Array(64), ch.publicKey); // signing key irrelevant here

    let banCb: ((e: { channelId: string; banRecord: string; banSig: string }) => void) | null = null;
    (socket.onPubchannelBan as jest.Mock).mockImplementation((cb: typeof banCb) => { banCb = cb; return () => {}; });
    const off = useChannels.getState().attachLive(identity);
    expect(banCb).not.toBeNull();

    const { signBan } = require('../../crypto/publicChannelKey') as typeof import('../../crypto/publicChannelKey');

    // Forged: signed with Eve's key, not the channel key → dropped.
    const forgedRecord = JSON.stringify({ banned: identity.aegisId, ts: Date.now(), channelId: CHANNEL_ID });
    const forgedSig = signBan(CHANNEL_ID, forgedRecord, eveKp.secretKey);
    banCb!({ channelId: CHANNEL_ID, banRecord: forgedRecord, banSig: encodeBase64(forgedSig) });
    await flush();
    expect(useChannels.getState().subscribed).toHaveLength(1); // NOT kicked by a forged ban
    expect(useChannels.getState().feeds[CHANNEL_ID]).toHaveLength(2);

    // Valid: signed with the channel key → Eve's posts purged + list updated.
    const validRecord = JSON.stringify({ banned: eve, ts: Date.now(), channelId: CHANNEL_ID });
    const validSig = signBan(CHANNEL_ID, validRecord, ch.secretKey);
    banCb!({ channelId: CHANNEL_ID, banRecord: validRecord, banSig: encodeBase64(validSig) });
    await flush();
    expect(useChannels.getState().banned[CHANNEL_ID]).toEqual([eve]);
    expect(useChannels.getState().feeds[CHANNEL_ID].map((p) => p.from)).toEqual([identity.aegisId]);

    off();
  });

  it('a valid ban naming ME drops the channel locally (kick)', async () => {
    const ch = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    seedOwnedChannel(new Uint8Array(64), ch.publicKey);

    let banCb: ((e: { channelId: string; banRecord: string; banSig: string }) => void) | null = null;
    (socket.onPubchannelBan as jest.Mock).mockImplementation((cb: typeof banCb) => { banCb = cb; return () => {}; });
    const off = useChannels.getState().attachLive(identity);

    const { signBan } = require('../../crypto/publicChannelKey') as typeof import('../../crypto/publicChannelKey');
    const record = JSON.stringify({ banned: identity.aegisId, ts: Date.now(), channelId: CHANNEL_ID });
    const sig = signBan(CHANNEL_ID, record, ch.secretKey);
    banCb!({ channelId: CHANNEL_ID, banRecord: record, banSig: encodeBase64(sig) });
    await flush();

    expect(useChannels.getState().subscribed).toHaveLength(0);
    expect(store.deleteChannel).toHaveBeenCalledWith(CHANNEL_ID);
    off();
  });

  it('loadFeed drops posts from banned authors but still advances the chain head', async () => {
    // Eve is a known contact so her post signature verifies — the drop must be
    // the ban filter, not a failed signature.
    mockContacts.push({ aegisId: eve, signingPublicKeyB64: encodeBase64(eveKp.publicKey) });
    useChannels.setState({ banned: { [CHANNEL_ID]: [eve] } });

    const p0 = sealAs('mine', null);
    const p1 = buildAndSealPost(CHANNEL_ID, { from: eve, body: 'banned post', ts: 1750000000001 }, p0.newHead, eveKp.secretKey, cek);
    (socket.pubchannelPull as jest.Mock).mockResolvedValue({
      ok: true,
      posts: [
        { seq_num: 0, ciphertext_b64: p0.wire.ciphertext, nonce_b64: p0.wire.nonce },
        { seq_num: 1, ciphertext_b64: p1.wire.ciphertext, nonce_b64: p1.wire.nonce },
      ],
    });

    await useChannels.getState().loadFeed(CHANNEL_ID, identity);

    expect(useChannels.getState().feeds[CHANNEL_ID].map((p) => p.body)).toEqual(['mine']);
    expect(useChannels.getState().heads[CHANNEL_ID]!.seqNum).toBe(1); // head past the filtered post
  });
});
