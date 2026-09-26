/**
 * openChannelPost must DROP a malformed sealed post (return null), never throw.
 *
 * Review finding (PR #442): any channel member holds the CEK, so they can seal
 * an inner payload with `ttlMs: "x"` or `seqNum: 1e30`. Those numbers are
 * encoded as u64 for the signature and hash chain (`setBigUint64`), which throws
 * a RangeError — and the throw escaped into the live `pubchannel:msg` handler.
 * Same file on desktop (`channelKeyParity.test.ts` keeps them identical).
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { openChannelPost, sealChannelPost, type ChannelPostInner } from '../publicChannelKey';
import { vk } from './helpers/rawIdentity';

const channelId = encodeBase64(nacl.randomBytes(16));
const cek = nacl.randomBytes(32);
const signer = nacl.sign.keyPair();
const resolve = () => signer.publicKey;

function sealRaw(inner: Record<string, unknown>): { c: string; n: string } {
  const nonce = nacl.randomBytes(24);
  const body = new TextEncoder().encode(JSON.stringify({ i: inner, s: encodeBase64(new Uint8Array(64)) }));
  return { c: encodeBase64(nacl.secretbox(body, nonce, cek)), n: encodeBase64(nonce) };
}

const good = {
  from: 'AAA-1111-2222',
  body: 'hi',
  ts: 1700000000000,
  seqNum: 1,
  prevHash: encodeBase64(new Uint8Array(32)),
  ttlMs: 0,
  attachmentsHash: encodeBase64(new Uint8Array(32)),
};

describe('openChannelPost on malformed sealed posts', () => {
  it('still opens a well-formed post', () => {
    const post: ChannelPostInner = {
      from: 'AAA-1111-2222', body: 'hi', ts: 1700000000000, seqNum: 1,
      prevHash: new Uint8Array(32), ttlMs: 0, attachmentsHash: new Uint8Array(32),
    };
    const sealed = sealChannelPost(channelId, post, vk(signer.secretKey), cek);
    expect(openChannelPost(channelId, sealed.ciphertextB64, sealed.nonceB64, cek, resolve)?.post.body).toBe('hi');
  });

  it.each([
    ['ttlMs is a string', { ttlMs: 'x' }],
    ['ttlMs is fractional', { ttlMs: 1.5 }],
    ['ttlMs is negative', { ttlMs: -1 }],
    ['seqNum exceeds u64', { seqNum: 1e30 }],
    ['seqNum is not an integer', { seqNum: 2.5 }],
    ['ts is beyond a safe integer', { ts: 2 ** 60 }],
    ['prevHash is not 32 bytes', { prevHash: encodeBase64(new Uint8Array(31)) }],
    ['attachmentsHash is not 32 bytes', { attachmentsHash: encodeBase64(new Uint8Array(33)) }],
  ])('drops it when %s', (_label, patch) => {
    const { c, n } = sealRaw({ ...good, ...patch });
    expect(() => openChannelPost(channelId, c, n, cek, resolve)).not.toThrow();
    expect(openChannelPost(channelId, c, n, cek, resolve)).toBeNull();
  });

  it('drops it (no throw) when handed a wrong-length content key', () => {
    const { c, n } = sealRaw(good);
    expect(openChannelPost(channelId, c, n, new Uint8Array(31), resolve)).toBeNull();
  });
});
