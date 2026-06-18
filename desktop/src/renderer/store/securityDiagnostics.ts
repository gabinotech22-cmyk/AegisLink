import { create } from 'zustand';
import '../crypto/ipc-types';

/**
 * securityDiagnostics.ts — Local-only security observability (desktop).
 *
 * Ported from mobile/src/store/securityDiagnostics.ts. Counts events that are
 * security-relevant but MUST NOT generate metadata on the wire. The canonical
 * case: a PQXDH (v2) handshake that fell back to classic v1 X3DH because we
 * advertised a PQ prekey yet the inbound init carried no ML-KEM ciphertext (see
 * shouldUsePqReceiver in crypto/signal/x3dh.ts). A legitimate v1 peer triggers
 * this; so could an active downgrade attacker. A sustained spike is the signal.
 *
 * PRIVACY (non-negotiable): every field here lives ONLY on this device. It is
 * never sent to the relay, never included in any backup payload, and carries no
 * per-message identifiers — only an aggregate count and a coarse timestamp.
 */

const secureStorage = () => window.aegis.secureStorage;
const STORAGE_KEY = 'aegis.secdiag.v1';

interface SecDiagSnapshot {
  /** Total times a v2-capable handshake fell back to classic v1 X3DH. */
  pqDowngradeFallbacks: number;
  /** Epoch ms of the most recent v1 fallback, or null if none yet. */
  lastPqDowngradeAt: number | null;
}

const DEFAULTS: SecDiagSnapshot = {
  pqDowngradeFallbacks: 0,
  lastPqDowngradeAt: null,
};

interface SecDiagState extends SecDiagSnapshot {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Record one PQXDH→v1 downgrade fallback. Fire-and-forget safe. */
  recordPqDowngrade: () => Promise<void>;
  /** Clear all counters (e.g. user-initiated from a diagnostics screen). */
  reset: () => Promise<void>;
}

async function persist(snap: SecDiagSnapshot): Promise<void> {
  try {
    await secureStorage().set(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    /* best-effort: diagnostics must never break the message path */
  }
}

export const useSecurityDiagnostics = create<SecDiagState>((setState, get) => ({
  ...DEFAULTS,
  hydrated: false,

  async hydrate() {
    try {
      const raw = await secureStorage().get(STORAGE_KEY);
      if (raw) {
        const loaded = JSON.parse(raw) as Partial<SecDiagSnapshot>;
        setState({ ...DEFAULTS, ...loaded, hydrated: true });
        return;
      }
    } catch {
      /* fall through to defaults */
    }
    setState({ hydrated: true });
  },

  async recordPqDowngrade() {
    // Hydrate first so we increment the persisted value rather than clobbering
    // it from the default 0 (may fire before app-level hydrate).
    if (!get().hydrated) await get().hydrate();
    const next: SecDiagSnapshot = {
      pqDowngradeFallbacks: get().pqDowngradeFallbacks + 1,
      lastPqDowngradeAt: Date.now(),
    };
    setState(next);
    await persist(next);
  },

  async reset() {
    setState({ ...DEFAULTS });
    await secureStorage().delete(STORAGE_KEY);
  },
}));
