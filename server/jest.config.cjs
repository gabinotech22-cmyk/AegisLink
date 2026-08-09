/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Passthrough for `node:`-prefixed core modules (e.g. `node:sqlite`) — see
  // jest.resolver.cjs for why this is needed on some Node 22.x CI runners.
  resolver: '<rootDir>/jest.resolver.cjs',
  // Run suites serially. These integration tests stand up a real relay +
  // Socket.IO server and share module-level singletons (the node:sqlite handle,
  // AEGIS_DB_PATH, the relay). Under parallel workers, suite→worker assignment
  // depends on the host core count, so CI (different hardware than local) hit
  // cross-suite module-state and teardown races that never reproduced locally.
  // Serial execution removes the whole class of races; the suite is small (~20s).
  maxWorkers: 1,
  // Close the DB after every test file (release the native node:sqlite handle)
  // so leaked handles can't be touched post-teardown and cascade across suites.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // The e2e harness (src/__tests__/e2e/) imports the app's real crypto from
  // ../../mobile/src/crypto/**. Jest resolves bare specifiers by walking UP from
  // the IMPORTING file, so `tweetnacl-util` inside mobile/src/crypto/aegisId.ts
  // searches mobile/**/node_modules and then the repo root — never
  // server/node_modules. That works on a dev machine, where mobile/node_modules
  // happens to exist, and fails in CI, where the server job only runs `npm ci`
  // in server/. modulePaths adds server/node_modules as an absolute resolution
  // root so the mobile sources find the deps this package already declares
  // (tweetnacl, tweetnacl-util, @noble/hashes, @noble/post-quantum).
  modulePaths: ['<rootDir>/node_modules'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Replace the native-ESM expo-server-sdk with a CJS-compatible stub
    '^expo-server-sdk$': '<rootDir>/src/__mocks__/expo-server-sdk.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
      },
    ],
  },
};
