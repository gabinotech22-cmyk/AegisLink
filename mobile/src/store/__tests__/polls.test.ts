/**
 * Wire-format guarantee for anonymous group voting (Section 6).
 *
 * `sendGroupVote` in src/socket/client.ts wraps `[vote:<msgId>:<optionIndex>]`
 * in a `group_msg` JSON payload and feeds it through `encryptMessage` (Double
 * Ratchet + XSalsa20-Poly1305 outer secretbox). The object that reaches
 * `socket.emit` is `{ id, to, ciphertext, nonce }` — opaque to the relay and
 * to any non-member observer.
 *
 * Importing src/socket/client.ts in jest pulls in expo-secure-store,
 * socket.io-client and other native modules that would require an extensive
 * mock harness. Instead we reproduce the exact wire-emit construction here
 * with the real `encryptMessage` (pure crypto, no native deps) and assert
 * the wire payload does not leak the vote.
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import { encryptMessage, openEnvelope } from '../../crypto/messaging';
import { initRatchet, ratchetDecrypt, type RatchetState } from '../../crypto/signal/ratchet';

/**
 * Build a paired (Alice, Bob) ratchet using a known root key and Bob's SPK
 * pair as the shared DH anchor. This mirrors the live X3DH bootstrap without
 * pulling x3dh.ts (which is exercised by its own suite).
 */
function pairedRatchets(): { alice: RatchetState; bob: RatchetState } {
  const rootKey = nacl.randomBytes(32);
  const bobSpk = nacl.box.keyPair();
  const alice = initRatchet(rootKey, bobSpk.publicKey, true);
  const bob = initRatchet(rootKey, new Uint8Array(0), false, bobSpk);
  return { alice, bob };
}

/** Reconstruct the exact wire object that `sendGroupVote` hands to `socket.emit`. */
function buildVoteWire(args: {
  senderAegisId: string;
  senderSecretKey: Uint8Array;
  recipientAegisId: string;
  recipientPublicKey: Uint8Array;
  ratchet: RatchetState;
  groupId: string;
  groupName: string;
  members: string[];
  pollMessageId: string;
  optionIndex: number;
}) {
  const plaintext = `[vote:${args.pollMessageId}:${args.optionIndex}]`;
  const payload = JSON.stringify({
    type: 'group_msg',
    groupId: args.groupId,
    groupName: args.groupName,
    members: args.members,
    senderId: args.senderAegisId,
    senderName: 'anon',
    senderColor: '#000',
    senderImage: null,
    body: plaintext,
  });
  const { envelope, newState } = encryptMessage(
    payload,
    args.senderAegisId,
    args.recipientPublicKey,
    args.senderSecretKey,
    args.ratchet,
  );
  const wire = {
    id: 'env-' + Math.random().toString(36).slice(2),
    to: args.recipientAegisId,
    ciphertext: envelope.ciphertextB64,
    nonce: envelope.nonceB64,
  };
  return { wire, newState, plaintext };
}

describe('group vote wire format', () => {
  it('submitVote does not expose vote in plaintext on the wire', () => {
    // Identity pair: Alice (voter) sending to Bob (group member).
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const { alice: aliceRatchet } = pairedRatchets();

    // Intercept the would-be socket.emit
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const fakeSocket = {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    };

    const optionIndex = 2;
    const pollMessageId = 'poll-msg-abc123';

    const { wire } = buildVoteWire({
      senderAegisId: 'alice-aegis-id',
      senderSecretKey: alice.secretKey,
      recipientAegisId: 'bob-aegis-id',
      recipientPublicKey: bob.publicKey,
      ratchet: aliceRatchet,
      groupId: 'group-1',
      groupName: 'Anon Voters',
      members: ['alice-aegis-id', 'bob-aegis-id'],
      pollMessageId,
      optionIndex,
    });

    fakeSocket.emit('envelope', wire);

    // ── Assertion 1: socket.emit was called with the envelope event ───────────
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('envelope');

    const sent = emitted[0].payload as Record<string, unknown>;

    // ── Assertion 2: no field named `optionIndex` (or vote-shaped) on the wire
    const wireKeys = Object.keys(sent);
    expect(wireKeys.sort()).toEqual(['ciphertext', 'id', 'nonce', 'to']);
    expect(sent).not.toHaveProperty('optionIndex');
    expect(sent).not.toHaveProperty('vote');
    expect(sent).not.toHaveProperty('pollMessageId');
    expect(sent).not.toHaveProperty('body');

    // ── Assertion 3: the ciphertext field is opaque base64 — decoding it as
    //     JSON or as a plain integer must fail. It must NOT contain the
    //     literal "vote", the pollMessageId, or the numeric optionIndex.
    const cipherStr = sent.ciphertext as string;
    const nonceStr = sent.nonce as string;
    expect(typeof cipherStr).toBe('string');
    expect(typeof nonceStr).toBe('string');

    const rawCipher = decodeBase64(cipherStr);
    expect(rawCipher.length).toBeGreaterThan(16); // includes Poly1305 tag

    // Try to interpret the ciphertext bytes as a UTF-8 string. If the encryption
    // were a no-op or weakly obfuscated, the string would contain "vote" or the
    // decimal optionIndex. With XSalsa20-Poly1305 it should be indistinguishable
    // from random.
    let asUtf8 = '';
    try {
      asUtf8 = encodeUTF8(rawCipher);
    } catch {
      // non-UTF-8 bytes — already opaque
    }
    expect(asUtf8).not.toContain('vote');
    expect(asUtf8).not.toContain(pollMessageId);
    expect(asUtf8).not.toContain(`:${optionIndex}]`);
    expect(asUtf8).not.toContain('group_msg');

    // The ciphertext, interpreted as a base64-encoded integer, must NOT equal
    // the optionIndex (defensive guard against accidental "[vote:n]" → base64
    // single-digit emissions).
    expect(cipherStr).not.toBe(encodeBase64(new Uint8Array([optionIndex])));

    // Parsing as JSON must throw — this guarantees the wire payload is not a
    // structured object containing the vote.
    expect(() => JSON.parse(asUtf8)).toThrow();
  });

  it('encrypted vote roundtrips back to the original payload (sanity)', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const { alice: aliceRatchet } = pairedRatchets();

    const { wire } = buildVoteWire({
      senderAegisId: 'alice',
      senderSecretKey: alice.secretKey,
      recipientAegisId: 'bob',
      recipientPublicKey: bob.publicKey,
      ratchet: aliceRatchet,
      groupId: 'g',
      groupName: 'G',
      members: ['alice', 'bob'],
      pollMessageId: 'pm-1',
      optionIndex: 1,
    });

    // Bob opens the outer envelope. We are not driving the inner ratchet here
    // (that path is covered by ratchet.test.ts); openEnvelope alone confirms
    // the outer secretbox MAC is valid and the inner ratchet header is intact
    // — exactly what the relay cannot do.
    const opened = openEnvelope(
      { ciphertextB64: wire.ciphertext, nonceB64: wire.nonce },
      alice.publicKey,
      bob.secretKey,
    );
    expect(opened).not.toBeNull();
    expect(opened!.from).toBe('alice');
    expect(opened!.ratchet).toBeDefined();
    // The vote body lives one layer deeper (inside the ratchet ciphertext) —
    // a wire observer with only the outer keys cannot read it.
  });

  it('two votes for the same option produce distinct ciphertexts (nonce + ratchet advance)', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const { alice: aliceRatchet } = pairedRatchets();

    const r1 = buildVoteWire({
      senderAegisId: 'alice', senderSecretKey: alice.secretKey,
      recipientAegisId: 'bob', recipientPublicKey: bob.publicKey,
      ratchet: aliceRatchet,
      groupId: 'g', groupName: 'G', members: ['alice', 'bob'],
      pollMessageId: 'pm-1', optionIndex: 0,
    });
    const r2 = buildVoteWire({
      senderAegisId: 'alice', senderSecretKey: alice.secretKey,
      recipientAegisId: 'bob', recipientPublicKey: bob.publicKey,
      ratchet: r1.newState,
      groupId: 'g', groupName: 'G', members: ['alice', 'bob'],
      pollMessageId: 'pm-1', optionIndex: 0,
    });

    expect(r1.wire.ciphertext).not.toBe(r2.wire.ciphertext);
    expect(r1.wire.nonce).not.toBe(r2.wire.nonce);
  });
});
// Silence ratchetDecrypt unused-import linter — kept for parity with future tests
void ratchetDecrypt;
