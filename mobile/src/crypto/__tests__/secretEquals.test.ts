/**
 * Golden rule #8: the prekey write-then-readback checks compare secrets in
 * constant time (`secretB64Equals`), never with `===` on the base64 strings.
 */
import fs from 'fs';
import path from 'path';
import { encodeBase64 } from 'tweetnacl-util';
import { nacl } from '../sodium';
import { secretB64Equals } from '../secretEquals';

describe('secretB64Equals', () => {
  it('matches equal secrets and rejects different, missing or malformed ones', () => {
    const k = nacl.randomBytes(2400);
    const b64 = encodeBase64(k);
    expect(secretB64Equals(encodeBase64(k.slice()), b64)).toBe(true);
    const flipped = k.slice();
    flipped[2399] ^= 1;
    expect(secretB64Equals(encodeBase64(flipped), b64)).toBe(false);
    expect(secretB64Equals(encodeBase64(k.slice(0, 32)), b64)).toBe(false);
    expect(secretB64Equals(null, b64)).toBe(false);
    expect(secretB64Equals(undefined, b64)).toBe(false);
    expect(secretB64Equals('%%%not base64%%%', b64)).toBe(false);
  });

  it('no readback of a prekey secret is compared with === anymore', () => {
    const root = path.resolve(__dirname, '../..');
    for (const rel of ['crypto/signal/x3dh.ts', 'crypto/registration.ts', 'socket/client.ts']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src).not.toMatch(/back\s*===/);
      expect(src).toMatch(/secretB64Equals\(back,/);
    }
  });
});
