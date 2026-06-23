/**
 * Mailbox root mockStore — sealed-sender Fase 4 (client side).
 */
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn((k: string) => Promise.resolve(mockStore.get(k) ?? null)),
  setItemAsync: jest.fn((k: string, v: string) => { mockStore.set(k, v); return Promise.resolve(); }),
  deleteItemAsync: jest.fn((k: string) => { mockStore.delete(k); return Promise.resolve(); }),
}));

import {
  getOwnMailboxRoot,
  getOwnMailboxRootB64,
  setContactMailboxRoot,
  getContactMailboxRoot,
  getOwnCurrentMailbox,
  getContactCurrentMailboxId,
} from '../mailboxStore';
import { currentMailbox } from '../mailbox';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import nacl from 'tweetnacl';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

beforeEach(() => mockStore.clear());

describe('own mailbox root', () => {
  it('generates a 32-byte root once and returns the same value after', async () => {
    const a = await getOwnMailboxRoot();
    expect(a).toHaveLength(32);
    const b = await getOwnMailboxRoot();
    expect(toHex(a)).toBe(toHex(b)); // persisted, not regenerated
  });

  it('getOwnMailboxRootB64 round-trips to the persisted root', async () => {
    const b64 = await getOwnMailboxRootB64();
    expect(toHex(decodeBase64(b64))).toBe(toHex(await getOwnMailboxRoot()));
  });

  it('getOwnCurrentMailbox derives from the persisted root', async () => {
    const root = await getOwnMailboxRoot();
    const mb = await getOwnCurrentMailbox(1_000_000_000_000);
    expect(mb.mailboxIdB64).toBe(currentMailbox(root, 1_000_000_000_000).mailboxIdB64);
  });
});

describe('contact mailbox roots', () => {
  it('stores and returns a contact root, and derives the same id the contact would', async () => {
    const contactRoot = nacl.randomBytes(32);
    const now = 1_700_000_000_000;
    await setContactMailboxRoot('K3M-7QPA-9WZX', encodeBase64(contactRoot));

    const mockStored = await getContactMailboxRoot('K3M-7QPA-9WZX');
    expect(mockStored && toHex(mockStored)).toBe(toHex(contactRoot));

    const addressedId = await getContactCurrentMailboxId('K3M-7QPA-9WZX', now);
    expect(addressedId).toBe(currentMailbox(contactRoot, now).mailboxIdB64);
  });

  it('returns null when no root has been shared (→ caller falls back to aegisId)', async () => {
    expect(await getContactMailboxRoot('AAA-AAAA-AAAA')).toBeNull();
    expect(await getContactCurrentMailboxId('AAA-AAAA-AAAA', 0)).toBeNull();
  });

  it('ignores malformed / wrong-length roots', async () => {
    await setContactMailboxRoot('BBB-BBBB-BBBB', 'not-base64!!');
    await setContactMailboxRoot('BBB-BBBB-BBBB', encodeBase64(nacl.randomBytes(16))); // too short
    expect(await getContactMailboxRoot('BBB-BBBB-BBBB')).toBeNull();
  });
});
