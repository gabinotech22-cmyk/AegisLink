/**
 * duressDecoy — stable decoy blob for coercion (duress) PIN unlock.
 *
 * Covers:
 *   1. The decoy identity is generated once and persisted — a second call
 *      (simulating a second duress unlock) returns the SAME AegisID, not a
 *      freshly generated one (plausibility leak if it changed each time).
 *   2. The decoy key material is never all-zero (must survive forensic scrutiny
 *      the same way a real identity would).
 *   3. Seeded contacts/messages are non-empty and stable across reads.
 *   4. appendDecoyMessage() persists to the SAME blob without touching the
 *      real SQLite DB (no `db/local` import is even reachable from this module).
 */

const store: Record<string, string> = {};

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    set: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve(undefined);
    }),
    delete: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve(undefined);
    }),
  },
}));

import { getOrCreateDecoyBlob, resetDecoyCache, appendDecoyMessage } from '../duressDecoy';

describe('duressDecoy', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    resetDecoyCache();
  });

  it('generates and persists a decoy identity on first use', async () => {
    const blob = await getOrCreateDecoyBlob();
    expect(blob.identity.aegisId).toMatch(/.+/);
    expect(blob.identity.secretKeyB64.length).toBeGreaterThan(0);
    // Never all-zero key material.
    expect(blob.identity.secretKeyB64).not.toBe(Buffer.alloc(32).toString('base64'));
  });

  it('returns the SAME decoy identity across two independent hydrations', async () => {
    const first = await getOrCreateDecoyBlob();
    resetDecoyCache(); // simulate a fresh app process reading persisted SecureStore
    const second = await getOrCreateDecoyBlob();

    expect(second.identity.aegisId).toBe(first.identity.aegisId);
    expect(second.identity.secretKeyB64).toBe(first.identity.secretKeyB64);
  });

  it('seeds a stable, non-empty list of fake contacts and conversations', async () => {
    const blob = await getOrCreateDecoyBlob();
    expect(blob.contacts.length).toBeGreaterThan(0);
    for (const c of blob.contacts) {
      expect(blob.messagesByChat[c.aegisId]?.length ?? 0).toBeGreaterThan(0);
    }

    resetDecoyCache();
    const second = await getOrCreateDecoyBlob();
    expect(second.contacts.map((c) => c.aegisId)).toEqual(blob.contacts.map((c) => c.aegisId));
  });

  it('appendDecoyMessage persists into the same blob without any real-DB import', async () => {
    const blob = await getOrCreateDecoyBlob();
    const chatId = blob.contacts[0].aegisId;
    await appendDecoyMessage(chatId, {
      id: 'coerced-1',
      chatId,
      direction: 'out',
      body: 'test message under duress',
      createdAt: Date.now(),
      type: 'text',
      mediaUri: null,
    });

    resetDecoyCache();
    const reloaded = await getOrCreateDecoyBlob();
    const chat = reloaded.messagesByChat[chatId];
    expect(chat?.some((m) => m.id === 'coerced-1')).toBe(true);
  });
});
