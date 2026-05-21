import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8, decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { ratchetEncrypt, ratchetDecrypt, type RatchetState } from './signal/ratchet';
import { stripAndPad, unpad } from './metadata';

interface InnerRatchet {
  ratchetKeyB64: string;
  n: number;
  pn: number;
  ciphertextB64: string;
  nonceB64: string;
}

interface InnerPayload {
  v: number;
  from: string;
  ratchet: InnerRatchet;
  x3dh?: Record<string, unknown>;
  [key: string]: unknown;
}

const PROTOCOL_VERSION = 2;

export interface EncryptedEnvelope {
  ciphertextB64: string;
  nonceB64: string;
}

export interface DecryptedInner {
  from: string;
  body: string;
  newState: RatchetState;
}

export function encryptMessage(
  plaintext: string,
  senderAegisId: string,
  recipientPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
  ratchetState: RatchetState
): { envelope: EncryptedEnvelope; newState: RatchetState } {
  const payloadBytes = decodeUTF8(plaintext);
  const ratchetOut = ratchetEncrypt(ratchetState, payloadBytes);

  const innerPayload: Record<string, unknown> = {
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

  if (ratchetState.x3dhInit) {
    innerPayload.x3dh = ratchetState.x3dhInit;
  }

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

export function openEnvelope(
  envelope: EncryptedEnvelope,
  senderPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): InnerPayload | null {
  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
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
  return parsed as InnerPayload;
}

export function tryDecryptMessage(
  envelope: EncryptedEnvelope,
  senderPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
  ratchetState: RatchetState
): DecryptedInner | null {
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

    return {
      from: parsed.from,
      body: encodeUTF8(plaintextBytes),
      newState: ratchetState,
    };
  } catch {
    return null;
  }
}
