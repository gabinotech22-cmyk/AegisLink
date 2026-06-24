import { sha256 } from '@noble/hashes/sha2.js';
import { WORDLIST_256 } from './wordlist';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * 8 hex groups of 4 chars each = 32 hex chars = 128 bits of the SHA-256
 * digest. This is the AUTHORITATIVE fingerprint — use it (not the words
 * below) for any decision that actually depends on collision resistance.
 */
export function fingerprintHex(publicKey: Uint8Array): string[] {
  const digest = sha256(publicKey);
  const hex = toHex(digest.slice(0, 16));
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(hex.slice(i * 4, i * 4 + 4));
  return groups;
}

/**
 * 8 evocative words derived from SHA-256 of the public key — a human-memorable
 * MNEMONIC, not a second independent fingerprint. Each word encodes one byte
 * (8 bits) from a 256-word list, so this carries only 64 bits of the digest —
 * half of `fingerprintHex`'s 128 bits. Treat the hex string as authoritative
 * for verification; the words are a convenience for reading it aloud, not an
 * equally-strong alternative (mirrors mobile/src/crypto/fingerprint.ts).
 */
export function fingerprintWords(publicKey: Uint8Array): string[] {
  const digest = sha256(publicKey);
  const words: string[] = [];
  for (let i = 0; i < 8; i++) words.push(WORDLIST_256[digest[i]]);
  return words;
}
