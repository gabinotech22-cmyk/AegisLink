import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * sealedReceiptsTyping.test.ts — audit 2026-09-24 R-1 (desktop parity).
 *
 * Typing indicators and read receipts travel ONLY sealed inside the E2EE
 * ratchet. The plaintext `typing` / `msg:read` relay events are gone in both
 * directions: sending them relinked the me↔to edge outside mailbox mode, and
 * listening for them trusted a relay-stamped `from` a malicious relay could
 * forge. The client module touches the window.aegis preload bridge and cannot
 * load under node-env vitest, so this guards its source; the behaviour itself is
 * covered on mobile by client.federationControlPlane.test.ts.
 */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.ts'), 'utf8');

describe('desktop socket client: typing and read receipts are sealed-only', () => {
  test.each(['typing', 'msg:read', 'msg:delete'])('never emits plaintext %s', (event) => {
    expect(src).not.toMatch(new RegExp(`socket[!?]?\\.emit\\(\\s*['"]${event}['"]`));
  });

  test.each(['typing', 'msg:read', 'msg:delete'])('never listens for plaintext %s', (event) => {
    expect(src).not.toMatch(new RegExp(`socket[!?]?\\.on\\(\\s*['"]${event}['"]`));
  });

  test('sends both as ratchet messages', () => {
    expect(src).toContain("type: 'typing'");
    expect(src).toContain("type: 'read_receipt'");
  });
});
