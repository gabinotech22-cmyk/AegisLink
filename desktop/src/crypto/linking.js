import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8 } from 'tweetnacl-util';
import QRCode from 'qrcode';

/**
 * Spec-aligned linking payload generator. Returns the raw JSON QR string and
 * the ephemeral secret key the renderer MUST hold only in memory and discard
 * after decryptLinkingResponse completes (success OR failure).
 */
export function generateLinkingPayload(relayUrl) {
  const ephemeral = nacl.box.keyPair();
  return {
    qrData: JSON.stringify({
      v: 1,
      pubKey: encodeBase64(ephemeral.publicKey),
      relay: relayUrl,
    }),
    ephemeralSecretKey: ephemeral.secretKey,
  };
}

/**
 * Best-effort zeroization for the ephemeral secret. Call this once linking
 * completes — the harness drops the binding right after.
 */
export function destroyEphemeralSecret(ephemeralSecretKey) {
  if (!ephemeralSecretKey) return;
  for (let i = 0; i < ephemeralSecretKey.length; i++) ephemeralSecretKey[i] = 0;
}

/**
 * Generate the QR payload the desktop displays for the mobile to scan.
 * The desktop creates an ephemeral X25519 box keypair. The mobile uses the
 * advertised `pubKey` to encrypt its identity proof via nacl.box. The
 * ephemeral secret key NEVER leaves desktop memory and is discarded after
 * the linking flow completes.
 */
export async function generateLinkingQR(relayUrl) {
  const ephemeralKeypair = nacl.box.keyPair();
  const qrPayload = {
    v: 1,
    pubKey: encodeBase64(ephemeralKeypair.publicKey),
    relay: relayUrl,
  };
  const dataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload), {
    width: 260,
    margin: 1,
    color: { dark: '#0a0e0d', light: '#e8f5f0' },
  });
  return { dataUrl, session: { ephemeralKeypair, qrPayload } };
}

/**
 * Decrypts the response the mobile sends after scanning the QR.
 *
 * The mobile builds: nacl.box(JSON, nonce, desktopEphemeralPubKey, mobileSenderSecretKey)
 * and sends { ciphertext, nonce, senderPubKey } over the relay.
 *
 * Returns the parsed JSON payload (typically { aegisId, signingPublicKeyB64, displayName? })
 * or null if MAC verification fails or the payload is malformed.
 */
export function decryptLinkingResponse(encryptedResponse, ephemeralSecretKey) {
  if (!encryptedResponse || typeof encryptedResponse !== 'object') return null;
  let ciphertext, nonce, senderPubKey;
  try {
    ciphertext = decodeBase64(encryptedResponse.ciphertext);
    nonce = decodeBase64(encryptedResponse.nonce);
    senderPubKey = decodeBase64(encryptedResponse.senderPubKey);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.box.nonceLength) return null;
  if (senderPubKey.length !== nacl.box.publicKeyLength) return null;

  const opened = nacl.box.open(ciphertext, nonce, senderPubKey, ephemeralSecretKey);
  if (!opened) return null;

  try {
    return JSON.parse(encodeUTF8(opened));
  } catch {
    return null;
  }
}

/**
 * Test / mobile-side helper. NOT used in production desktop runtime — exposed so
 * the round-trip test can simulate what the mobile would send.
 */
export function encryptLinkingResponse(payload, desktopEphemeralPubKey, mobileKeyPair) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = nacl.box(plaintext, nonce, desktopEphemeralPubKey, mobileKeyPair.secretKey);
  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    senderPubKey: encodeBase64(mobileKeyPair.publicKey),
  };
}
