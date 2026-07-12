/**
 * Delete-identity (useIdentity.reset()) wipes the app-lock + coercion (duress)
 * PIN. Desktop parity with mobile
 * mobile/src/store/__tests__/identityResetWipesLockPins.test.ts.
 *
 * reset() must route through purgeLockAndDuressSecrets() so a delete-identity
 * clears exactly the same lock/coercion secrets a panic wipe does. This also
 * covers the desktop escape hatch where a failed wipeDatabase() falls back to
 * reset() (App.tsx) — that fallback must still leave no PIN behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── db/local (top-level import in the store) ───────────────────────────────
const mockDeleteIdentitySlot = vi.fn().mockResolvedValue(undefined);
const mockPurge = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db/local', () => ({
  loadIdentity: vi.fn().mockResolvedValue(null),
  saveIdentity: vi.fn().mockResolvedValue(undefined),
  setActiveDbSlot: vi.fn().mockResolvedValue(undefined),
  closeActiveDatabase: vi.fn().mockResolvedValue(undefined),
  deleteIdentitySlot: (...a: unknown[]) => mockDeleteIdentitySlot(...a),
  purgeLockAndDuressSecrets: (...a: unknown[]) => mockPurge(...a),
}));

// ── Zustand stores reset() brings in sync (dynamically imported) ───────────
vi.mock('../contacts', () => ({ useContacts: { setState: vi.fn() } }));
vi.mock('../groups', () => ({ useGroups: { setState: vi.fn() } }));
vi.mock('../messages', () => ({ useMessages: { setState: vi.fn() } }));

vi.mock('../../crypto/registration', () => ({
  fetchPowChallenge: vi.fn(),
  solvePoW: vi.fn(),
  uploadIdentityAndPrekeys: vi.fn(),
}));
vi.mock('../../crypto/signal/x3dh', () => ({ generatePreKeys: vi.fn() }));
vi.mock('../../config', () => ({ SERVER_URL: 'https://test.invalid' }));

beforeEach(() => {
  vi.clearAllMocks();
  // Stub the preload bridge the store reaches for slot bookkeeping deletes.
  (globalThis as unknown as { window: { aegis: unknown } }).window = {
    aegis: { secureStorage: { delete: vi.fn().mockResolvedValue(undefined), set: vi.fn(), get: vi.fn() } },
  };
});

describe('useIdentity.reset() — wipes lock + coercion PINs (desktop parity)', () => {
  it('routes through purgeLockAndDuressSecrets so the lock/coercion PIN never survives', async () => {
    const { useIdentity } = await import('../identity');
    await useIdentity.getState().reset();
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockDeleteIdentitySlot).toHaveBeenCalled();
  });
});
