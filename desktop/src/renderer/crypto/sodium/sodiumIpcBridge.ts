/**
 * The renderer's handle on native libsodium: the `sodium` surface the preload
 * exposes on `window.aegis` (src/preload/index.ts → src/main/ipc/sodium.ts).
 *
 * Fail closed: without the bridge there is NO crypto — never a silent fallback
 * to a JS implementation (golden rule #1). The unit tests swap this module for
 * an in-process bridge over the same main-process operation table
 * (vitest.config.ts alias → `src/main/crypto/sodium/__tests__/directBridge.ts`).
 */
import type { SodiumBridge } from '../ipc-types';

export function sodiumBridge(): SodiumBridge {
  const bridge = (globalThis as { window?: { aegis?: { sodium?: SodiumBridge } } }).window?.aegis?.sodium;
  if (!bridge) throw new Error('native crypto bridge unavailable (window.aegis.sodium)');
  return bridge;
}
