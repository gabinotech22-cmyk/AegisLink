import { sha256 } from '@noble/hashes/sha2';
import { WORDLIST_256 } from './wordlist';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 8 hex groups of 4 chars each. */
export function fingerprintHex(publicKey: Uint8Array): string[] {
  const digest = sha256(publicKey);
  const hex = toHex(digest.slice(0, 16));
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(hex.slice(i * 4, i * 4 + 4));
  return groups;
}

/** 8 evocative words derived from SHA-256 of the public key. */
export function fingerprintWords(publicKey: Uint8Array): string[] {
  const digest = sha256(publicKey);
  const words: string[] = [];
  for (let i = 0; i < 8; i++) words.push(WORDLIST_256[digest[i]]);
  return words;
}
