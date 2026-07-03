/**
 * channelService — verified channel orchestration (Phase 2e)
 *
 * Exercises the integrity rules end-to-end with real crypto (fixed seeds):
 * outgoing posts seal into a hash chain that ingest authenticates + verifies,
 * and tampering (forged signer, broken chain, relabeled seqNum, bad manifest
 * signature) is rejected.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  parseAndVerifyManifest,
  ingestChannelPosts,
  buildAndSealPost,
  normalizePullRow,
  encodePostBody,
  openPostBody,
  type ChainHead,
  type SealedWirePost,
} from '../channelService';
import {
  generateChannelIdentity,
  signManifest,
  type ChannelManifestData,
} from '../../crypto/publicChannelKey';

const SENDER_SEED = (() => {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i++) s[i] = (i * 5 + 1) & 0xff;
  return s;
})();
const senderKp = nacl.sign.keyPair.fromSeed(SENDER_SEED);
const SENDER_FROM = 'AEGIS-SENDER';

const cek = (() => {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (i * 7 + 3) & 0xff;
  return k;
})();

const CHANNEL_ID = 'SKKk3vgfTWu1MxRtJYx6DA==';

const resolver = (from: string) => (from === SENDER_FROM ? senderKp.publicKey : null);

/** Seal a chain of `n` posts via buildAndSealPost, returning wire posts + final head. */
function buildChain(n: number): { wire: SealedWirePost[]; head: ChainHead } {
  let head: ChainHead | null = null;
  const wire: SealedWirePost[] = [];
  for (let i = 0; i < n; i++) {
    const out = buildAndSealPost(
      CHANNEL_ID,
      { from: SENDER_FROM, body: `post ${i}`, ts: 1750000000000 + i },
      head,
      senderKp.secretKey,
      cek,
    );
    wire.push({ seqNum: out.seqNum, ciphertext: out.wire.ciphertext, nonce: out.wire.nonce });
    head = out.newHead;
  }
  return { wire, head: head! };
}

describe('outgoing → ingest round-trip', () => {
  it('accepts a full sealed chain in order and advances the head', () => {
    const { wire, head } = buildChain(3);
    const result = ingestChannelPosts(CHANNEL_ID, wire, cek, resolver, null);

    expect(result.rejected).toBe(0);
    expect(result.posts.map((p) => p.post.body)).toEqual(['post 0', 'post 1', 'post 2']);
    expect(result.posts.map((p) => p.post.seqNum)).toEqual([0, 1, 2]);
    expect(result.head!.seqNum).toBe(2);
    expect(encodeBase64(result.head!.postHash)).toBe(encodeBase64(head.postHash));
  });

  it('ingests posts shuffled on the wire by sorting on seqNum', () => {
    const { wire } = buildChain(3);
    const shuffled = [wire[2], wire[0], wire[1]];
    const result = ingestChannelPosts(CHANNEL_ID, shuffled, cek, resolver, null);
    expect(result.rejected).toBe(0);
    expect(result.posts.map((p) => p.post.seqNum)).toEqual([0, 1, 2]);
  });

  it('continues from a known head, ignoring already-seen seqNums', () => {
    const { wire } = buildChain(4);
    const first = ingestChannelPosts(CHANNEL_ID, wire.slice(0, 2), cek, resolver, null);
    const second = ingestChannelPosts(CHANNEL_ID, wire, cek, resolver, first.head);

    expect(second.posts.map((p) => p.post.seqNum)).toEqual([2, 3]); // 0,1 already past head
    expect(second.head!.seqNum).toBe(3);
  });
});

describe('integrity rejections', () => {
  it('drops a post signed by an unknown sender', () => {
    const { wire } = buildChain(1);
    const result = ingestChannelPosts(CHANNEL_ID, wire, cek, () => null, null);
    expect(result.posts).toHaveLength(0);
    expect(result.rejected).toBe(1);
    expect(result.head).toBeNull();
  });

  it('drops a post whose prevHash does not chain (forged middle post)', () => {
    const { wire } = buildChain(3);
    // Forge post 1 with a fresh independent chain (its prevHash won't match post 0).
    const forged = buildAndSealPost(
      CHANNEL_ID,
      { from: SENDER_FROM, body: 'forged', ts: 1750000009999 },
      { seqNum: 0, postHash: new Uint8Array(32).fill(9) },
      senderKp.secretKey,
      cek,
    );
    const tampered = [wire[0], { seqNum: 1, ciphertext: forged.wire.ciphertext, nonce: forged.wire.nonce }, wire[2]];
    const result = ingestChannelPosts(CHANNEL_ID, tampered, cek, resolver, null);

    // post 0 accepted; forged 1 dropped (bad prevHash); 2 dropped (links to real 1, absent).
    expect(result.posts.map((p) => p.post.seqNum)).toEqual([0]);
    expect(result.rejected).toBe(2);
    expect(result.head!.seqNum).toBe(0);
  });

  it('drops a post whose wire seqNum was relabeled by the relay', () => {
    const { wire } = buildChain(2);
    const relabeled = [wire[0], { ...wire[1], seqNum: 5 }]; // sealed seq is 1, wire says 5
    const result = ingestChannelPosts(CHANNEL_ID, relabeled, cek, resolver, null);
    expect(result.posts.map((p) => p.post.seqNum)).toEqual([0]);
    expect(result.rejected).toBe(1);
  });

  it('drops an undecryptable post (wrong CEK)', () => {
    const { wire } = buildChain(1);
    const wrongCek = new Uint8Array(32).fill(1);
    const result = ingestChannelPosts(CHANNEL_ID, wire, wrongCek, resolver, null);
    expect(result.posts).toHaveLength(0);
    expect(result.rejected).toBe(1);
  });
});

describe('parseAndVerifyManifest', () => {
  function signedBlob(overrides: Partial<Record<string, unknown>> = {}): string {
    const id = generateChannelIdentity();
    const manifest: ChannelManifestData = {
      channelId: id.channelId,
      salt: id.salt,
      channelEd25519Pub: id.channelEd25519Pub,
      name: 'My Channel',
      description: 'desc',
      avatarHash: null,
      channelType: 0,
      createdAtHourMs: 1750000000000,
      manifestSeq: 1,
      contentKeyHash: null,
      delegationsHash: new Uint8Array(32),
      revokedHash: new Uint8Array(32),
      pinnedPostSeq: -1,
      discussionsEnabled: true,
    };
    const sig = signManifest(manifest, id.channelEd25519Secret);
    const blob = {
      channelId: manifest.channelId,
      salt: encodeBase64(manifest.salt),
      channelEd25519Pub: encodeBase64(manifest.channelEd25519Pub),
      sig: encodeBase64(sig),
      name: manifest.name,
      description: manifest.description,
      avatarHash: null,
      channelType: manifest.channelType,
      createdAtHourMs: manifest.createdAtHourMs,
      manifestSeq: manifest.manifestSeq,
      contentKeyHash: null,
      delegationsHash: encodeBase64(manifest.delegationsHash),
      revokedHash: encodeBase64(manifest.revokedHash),
      pinnedPostSeq: manifest.pinnedPostSeq,
      discussionsEnabled: manifest.discussionsEnabled,
      ...overrides,
    };
    return JSON.stringify(blob);
  }

  it('accepts a validly signed manifest blob', () => {
    const m = parseAndVerifyManifest(signedBlob());
    expect(m).not.toBeNull();
    expect(m!.name).toBe('My Channel');
  });

  it('rejects a manifest whose name was tampered after signing', () => {
    expect(parseAndVerifyManifest(signedBlob({ name: 'Evil Channel' }))).toBeNull();
  });

  it('rejects malformed JSON and missing fields', () => {
    expect(parseAndVerifyManifest('not json')).toBeNull();
    expect(parseAndVerifyManifest('{}')).toBeNull();
  });
});

describe('post body senderName envelope (issue #204)', () => {
  it('round-trips text + senderName through encode/open', () => {
    const wire = encodePostBody('hello channel', 'Alice');
    expect(openPostBody(wire)).toEqual({ text: 'hello channel', senderName: 'Alice', media: null });
  });

  it('round-trips with no senderName provided', () => {
    const wire = encodePostBody('hello channel');
    expect(openPostBody(wire)).toEqual({ text: 'hello channel', senderName: null, media: null });
  });

  it('falls back to raw text for legacy (pre-#204) plain-text bodies', () => {
    expect(openPostBody('an old plain-text post')).toEqual({
      text: 'an old plain-text post',
      senderName: null,
      media: null,
    });
  });

  it('falls back gracefully for bodies that happen to be unrelated JSON', () => {
    const body = JSON.stringify({ foo: 'bar' });
    expect(openPostBody(body)).toEqual({ text: body, senderName: null, media: null });
  });

  it('round-trips an image media reference inside the sealed body', () => {
    const media = { kind: 'image' as const, uri: 'blob:abc:key:nonce', mime: 'image/jpeg', w: 1280, h: 720 };
    const wire = encodePostBody('caption', 'Bob', media);
    expect(openPostBody(wire)).toEqual({ text: 'caption', senderName: 'Bob', media });
  });

  it('carries a media-only post (empty text) without dropping the attachment', () => {
    const media = { kind: 'image' as const, uri: 'blob:abc:key:nonce' };
    const opened = openPostBody(encodePostBody('', undefined, media));
    expect(opened.text).toBe('');
    expect(opened.media).toEqual(media);
  });

  it('round-trips an audio voice note with its duration', () => {
    const media = { kind: 'audio' as const, uri: 'blob:v:k:n', mime: 'audio/m4a', durationMs: 4200 };
    const opened = openPostBody(encodePostBody('', undefined, media));
    expect(opened.media).toEqual(media);
  });

  it('rejects an untrusted media object with an unknown kind or oversized uri', () => {
    const badKind = openPostBody(JSON.stringify({ v: 1, text: 'x', media: { kind: 'exe', uri: 'blob:a' } }));
    expect(badKind.media).toBeNull();
    const hugeUri = openPostBody(JSON.stringify({ v: 1, text: 'x', media: { kind: 'image', uri: 'b'.repeat(5000) } }));
    expect(hugeUri.media).toBeNull();
  });

  it('sanitizes control characters and caps sender name length', () => {
    const evil = 'A'.repeat(100) + ' ';
    const wire = encodePostBody('hi', evil);
    const opened = openPostBody(wire);
    expect(opened.senderName).toHaveLength(64);
    expect(opened.senderName).toBe('A'.repeat(64));
  });

  it('drops a whitespace-only / empty sender name instead of storing garbage', () => {
    const wire = encodePostBody('hi', '   ');
    expect(openPostBody(wire).senderName).toBeNull();
  });

  it('full pipeline: seal with senderName, ingest, and open the body downstream', () => {
    const wireBody = encodePostBody('post with name', 'Bob');
    const sealed = buildAndSealPost(
      CHANNEL_ID,
      { from: SENDER_FROM, body: wireBody, ts: 1750000000123 },
      null,
      senderKp.secretKey,
      cek,
    );
    const result = ingestChannelPosts(
      CHANNEL_ID,
      [{ seqNum: sealed.seqNum, ciphertext: sealed.wire.ciphertext, nonce: sealed.wire.nonce }],
      cek,
      resolver,
      null,
    );
    expect(result.rejected).toBe(0);
    expect(result.posts).toHaveLength(1);
    const opened = openPostBody(result.posts[0].post.body);
    expect(opened).toEqual({ text: 'post with name', senderName: 'Bob', media: null });
  });

  it('a legacy plain-text post still chain-verifies and opens with senderName=null', () => {
    // Simulates a post sealed by a pre-#204 client (body = plain text, not JSON).
    const sealed = buildAndSealPost(
      CHANNEL_ID,
      { from: SENDER_FROM, body: 'legacy plain body', ts: 1750000000456 },
      null,
      senderKp.secretKey,
      cek,
    );
    const result = ingestChannelPosts(
      CHANNEL_ID,
      [{ seqNum: sealed.seqNum, ciphertext: sealed.wire.ciphertext, nonce: sealed.wire.nonce }],
      cek,
      resolver,
      null,
    );
    expect(result.rejected).toBe(0);
    const opened = openPostBody(result.posts[0].post.body);
    expect(opened).toEqual({ text: 'legacy plain body', senderName: null, media: null });
  });
});

describe('normalizePullRow', () => {
  it('normalizes snake_case DB rows', () => {
    expect(normalizePullRow({ seq_num: 4, ciphertext_b64: 'c', nonce_b64: 'n' }))
      .toEqual({ seqNum: 4, ciphertext: 'c', nonce: 'n' });
  });
  it('normalizes camelCase live rows', () => {
    expect(normalizePullRow({ seqNum: 2, ciphertext: 'c', nonce: 'n' }))
      .toEqual({ seqNum: 2, ciphertext: 'c', nonce: 'n' });
  });
  it('returns null for incomplete rows', () => {
    expect(normalizePullRow({ seqNum: 1, ciphertext: 'c' })).toBeNull();
  });
});
