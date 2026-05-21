import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8, decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { ratchetEncrypt, ratchetDecrypt } from './signal/ratchet.js';
import { stripAndPad, unpad } from './metadata.js';

const PROTOCOL_VERSION = 2;

export { stripAndPad };

export function encryptMessage(plaintext, senderAegisId, recipientPublicKey, mySecretKey, ratchetState) {
  const payloadBytes = decodeUTF8(plaintext);
  const ratchetOut = ratchetEncrypt(ratchetState, payloadBytes);

  const innerPayload = {
    v: PROTOCOL_VERSION,
    from: senderAegisId,
    ratchet: {
      ratchetKeyB64: encodeBase64(ratchetOut.header.ratchetKey),
      n: ratchetOut.header.n,
      pn: ratchetOut.header.pn,
      ciphertextB64: encodeBase64(ratchetOut.ciphertext),
      nonceB64: encodeBase64(ratchetOut.nonce),
    },
  };

  if (ratchetState.x3dhInit) innerPayload.x3dh = ratchetState.x3dhInit;

  const innerBytes = stripAndPad(innerPayload);
  const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
  const outerCiphertext = nacl.box(innerBytes, outerNonce, recipientPublicKey, mySecretKey);

  const newState = { ...ratchetState };
  delete newState.x3dhInit;

  return {
    envelope: {
      ciphertextB64: encodeBase64(outerCiphertext),
      nonceB64: encodeBase64(outerNonce),
    },
    newState,
  };
}

export function openEnvelope(envelope, senderPublicKey, mySecretKey) {
  let ciphertext, nonce;
  try {
    ciphertext = decodeBase64(envelope.ciphertextB64);
    nonce = decodeBase64(envelope.nonceB64);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.box.nonceLength) return null;

  const opened = nacl.box.open(ciphertext, nonce, senderPublicKey, mySecretKey);
  if (!opened) return null;

  const parsed = unpad(opened);
  if (!parsed) return null;
  if (parsed.v !== PROTOCOL_VERSION) return null;
  if (typeof parsed.from !== 'string' || !parsed.ratchet) return null;
  return parsed;
}

export function tryDecryptMessage(envelope, senderPublicKey, mySecretKey, ratchetState) {
  const parsed = openEnvelope(envelope, senderPublicKey, mySecretKey);
  if (!parsed) return null;
  try {
    const rHeader = {
      ratchetKey: decodeBase64(parsed.ratchet.ratchetKeyB64),
      n: parsed.ratchet.n,
      pn: parsed.ratchet.pn,
    };
    const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
    const rNonce = decodeBase64(parsed.ratchet.nonceB64);
    const plaintextBytes = ratchetDecrypt(ratchetState, rHeader, rCiphertext, rNonce);
    if (!plaintextBytes) return null;
    return { from: parsed.from, body: encodeUTF8(plaintextBytes), newState: ratchetState };
  } catch {
    return null;
  }
}
