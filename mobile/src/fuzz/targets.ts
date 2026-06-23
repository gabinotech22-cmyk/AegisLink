/**
 * Fuzz targets — untrusted-input parsers.
 *
 * Every function here takes attacker-controlled input (a scanned QR, a pasted
 * invite link, a message body arriving from the relay) and is contractually
 * required to FAIL SOFT: return null / a typed "not a match" result, never throw
 * and never hang. A throw or a timeout on arbitrary input is a crash bug (a
 * scan handler or render path blowing up on a malformed payload = DoS).
 *
 * Each target is a `(input: string) => void` that calls one parser and discards
 * the result — the point is to exercise the code path, not to check the value.
 * The in-repo runner (parsers.fuzz.test.ts) feeds these a seeded, structure-
 * aware corpus and asserts none of them throws. The SAME functions double as
 * Jazzer.js / OSS-Fuzz entry points (see fuzz/README.md): there an uncaught
 * throw IS the finding, so the targets deliberately do NOT swallow errors.
 */
import { parseIdentityQR, parseGroupInviteLink, universalToScheme } from '../crypto/qr';
import { parseMultiPayload } from '../utils/attachmentFormat';
import { parseGroupPostMarker } from '../utils/groupPost';
import { parseLocationMessage } from '../utils/parseLocationMessage';
import { unpad } from '../crypto/metadata';

export interface FuzzTarget {
  name: string;
  /** Seed strings that reach the interesting code paths (used to grow a corpus). */
  seeds: string[];
  run: (input: string) => void;
}

// UTF-8 encoder shared by the byte-oriented targets. The in-repo runner and the
// Jazzer harness both reach `unpad` through here, so the contract is identical.
const utf8 = new TextEncoder();

export const FUZZ_TARGETS: FuzzTarget[] = [
  {
    name: 'parseIdentityQR',
    seeds: [
      'aegislink://v1/ABC-DEFG-HJKL/QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQT0=',
      'https://aegislink.duckdns.org/a#v1/ABC-DEFG-HJKL/key',
      'aegislink://v1/ABC-DEFG-HJKL/',
    ],
    run: (s) => void parseIdentityQR(s),
  },
  {
    name: 'parseGroupInviteLink',
    seeds: [
      'aegislink://group/v1/gid/Group%20Name/admin',
      'https://aegislink.duckdns.org/g#v1/gid/Name/admin',
      'aegislink://group/v1/a/b/c',
    ],
    run: (s) => void parseGroupInviteLink(s),
  },
  {
    name: 'universalToScheme',
    seeds: [
      'https://aegislink.duckdns.org/g#v1/a/b/c',
      'https://aegislink.duckdns.org/a#v1/x/y',
    ],
    run: (s) => void universalToScheme(s),
  },
  {
    name: 'parseMultiPayload',
    seeds: [
      '[multi:2][image:blob:id:key:nonce][file:doc.pdf:blob:id:key:nonce]hi',
      '[multi:1][audio:30s:blob:id:key:nonce]',
      '[multi:0]',
    ],
    run: (s) => void parseMultiPayload(s),
  },
  {
    name: 'parseGroupPostMarker',
    seeds: ['[post:gps]hello', '[post:]x', '[post:abcdefghij]too-long'],
    run: (s) => void parseGroupPostMarker(s),
  },
  {
    name: 'parseLocationMessage',
    seeds: [
      '📍 Shared location (Exact, for 1 hour): Street X (Lat: 1.5, Lon: -2.3)',
      '📍 Ubicación (Aprox, durante 1 hora): Calle (Lat: 0, Lon: 0)',
      '📍(((((((((((((((((((((:',
    ],
    run: (s) => void parseLocationMessage(s),
  },
  {
    // Inner Double Ratchet payload deserializer. After the outer box is opened,
    // the decrypted bytes are FULLY controlled by a (malicious) authenticated
    // peer before they reach JSON.parse. `unpad` must fail soft (return null),
    // never throw and never hang, on arbitrary bytes — a throw here is a remote
    // crash triggerable by any contact. Fuzzed as UTF-8 bytes; the Jazzer
    // harness feeds raw bytes to the same function.
    name: 'unpadInnerPayload',
    seeds: [
      '{"v":2,"from":"ABC","ratchet":{"ratchetKeyB64":"AAA=","n":0,"pn":0,"ciphertextB64":"AAA=","nonceB64":"AAA="}}',
      '{"v":2,"from":"x","ratchet":{}}   ',
      '{"pad":"AAAA","v":2}',
      '{}',
      '[]',
      'null',
    ],
    run: (s) => void unpad(utf8.encode(s)),
  },
];
