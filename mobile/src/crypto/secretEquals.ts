/**
 * Constant-time equality for base64-encoded secret key material (golden rule
 * #8). Used by the write-then-readback checks that confirm a prekey secret was
 * stored durably: those compare a secret with its stored copy, so they must not
 * stop at the first differing character the way `===` on strings does.
 *
 * Returns false for a missing or undecodable value. Different lengths return
 * false after the same constant-time pass as an equal-length compare.
 */
import { decodeBase64 } from 'tweetnacl-util';
import { nacl } from './sodium';

export function secretB64Equals(stored: string | null | undefined, expected: string): boolean {
  if (typeof stored !== 'string') return false;
  let a: Uint8Array;
  let b: Uint8Array;
  try {
    a = decodeBase64(stored);
    b = decodeBase64(expected);
  } catch {
    return false;
  }
  if (a.length !== b.length) {
    nacl.verify(b, b);
    return false;
  }
  return nacl.verify(a, b);
}
