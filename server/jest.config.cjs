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
