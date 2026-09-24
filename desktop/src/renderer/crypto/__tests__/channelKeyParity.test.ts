/**
 * Channel key derivation must agree byte-for-byte across platforms, or a
 * channel created on one is unreadable on the other (golden rule #5). The
 * desktop files are copies of mobile's; this keeps them that way.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MOBILE_CRYPTO = path.resolve(__dirname, '../../../../../mobile/src/crypto');

describe('public-channel crypto is identical to mobile', () => {
  for (const file of ['publicChannelKey.ts', 'channelKey.ts']) {
    it(`${file} is byte-identical to mobile/src/crypto/${file}`, () => {
      const here = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const mobile = fs.readFileSync(path.join(MOBILE_CRYPTO, file), 'utf8');
      expect(here).toBe(mobile);
    });
  }
});
