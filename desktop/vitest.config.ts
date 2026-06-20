import { defineConfig } from 'vitest/config';

// Desktop unit tests run in a plain Node environment: the suites here cover the
// PURE renderer crypto core (X3DH/PQXDH, fingerprint, ratchet, sealed-sender,
// messaging) which depends only on tweetnacl/@noble — no Electron, no DOM, no
// window.aegis preload bridge. Modules that touch window.aegis (secureStorage,
// db/local) are intentionally out of scope until a jsdom + preload-mock harness
// is added; importing them here would throw at call time.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The crypto suites do real ML-KEM-768 keygen/encaps which is a touch slow
    // under coverage; keep a generous per-test timeout so CI never flakes.
    testTimeout: 20_000,
  },
});
