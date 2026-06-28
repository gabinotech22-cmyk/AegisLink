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
}));
jest.mock('../../socket/publicChannels', () => ({
  pubchannelJoin: jest.fn(),
  pubchannelPost: jest.fn(),
  pubchannelPull: jest.fn(),
  onPubchannelMsg: jest.fn(() => () => {}),
  onPubchannelTombstone: jest.fn(() => () => {}),
}));
jest.mock('../../crypto/publicChannelStore', () => ({
  saveChannelSecrets: jest.fn(async () => {}),
  getChannelCEK: jest.fn(),
  getChannelDeliveryToken: jest.fn(async () => 'tok'),
  isChannelOwned: jest.fn(async () => false),
  deleteChannel: jest.fn(async () => {}),
}));
jest.mock('../contacts', () => ({
  useContacts: { getState: () => ({ contacts: [] }) },
}));

import { useChannels } from '../channels';
import * as api from '../../api/publicChannels';
import * as socket from '../../socket/publicChannels';
import * as store from '../../crypto/publicChannelStore';
import {
  buildAndSealPost,
  type ChainHead,
} from '../../channels/channelService';
import {
  generateChannelIdentity,
  signManifest,
  type ChannelManifestData,
} from '../../crypto/publicChannelKey';
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
  useChannels.setState({ directory: [], loadingDirectory: false, subscribed: [], feeds: {}, heads: {} });
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
