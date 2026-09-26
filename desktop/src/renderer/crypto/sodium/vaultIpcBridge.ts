/**
 * The renderer's handle on the key vault in the main process (F-1b): the
 * `vault` surface the preload exposes on `window.aegis` (src/preload/index.ts
 * → src/main/ipc/vault.ts). Fail closed: without the bridge there are no keys.
 * Unit tests swap this module for an in-process bridge (vitest.config.ts alias
 * → `src/main/crypto/vault/__tests__/directBridge.ts`).
 */
import type { VaultBridge } from '../ipc-types';

export function vaultBridge(): VaultBridge {
  const bridge = (globalThis as { window?: { aegis?: { vault?: VaultBridge } } }).window?.aegis?.vault;
  if (!bridge) throw new Error('key vault bridge unavailable (window.aegis.vault)');
  return bridge;
}
