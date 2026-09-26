import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Desktop unit tests run in a plain Node environment: the suites here cover the
// renderer crypto core (X3DH/PQXDH, fingerprint, ratchet, sealed-sender,
// messaging) — no Electron, no DOM, no window.aegis preload bridge (the sodium
// bridge is aliased below). Modules that touch window.aegis (secureStorage,
// db/local) are intentionally out of scope until a jsdom + preload-mock harness
// is added; importing them here would throw at call time.
export default defineConfig({
  resolve: {
    // F-1: the renderer's crypto runs on native libsodium in the Electron main
    // process over IPC (window.aegis.sodium). Under Node there is no preload, so
    // the renderer facade's bridge is swapped for an in-process one over the
    // SAME main-process operation table (real sodium-native, IPC-style cloning).
    alias: [
      {
        find: /^\.\/vaultIpcBridge$/,
        replacement: path.resolve(__dirname, 'src/main/crypto/vault/__tests__/directBridge.ts'),
      },
      {
        find: /^\.\/sodiumIpcBridge$/,
        replacement: path.resolve(__dirname, 'src/main/crypto/sodium/__tests__/directBridge.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // F-1b: the primary profile's key vault starts unlocked, as after hydrate.
    setupFiles: ['src/renderer/crypto/__tests__/helpers/vaultSetup.ts'],
    // The crypto suites do real ML-KEM-768 keygen/encaps which is a touch slow
    // under coverage; keep a generous per-test timeout so CI never flakes.
    testTimeout: 20_000,
  },
});
