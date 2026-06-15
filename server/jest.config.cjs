/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Passthrough for `node:`-prefixed core modules (e.g. `node:sqlite`) — see
  // jest.resolver.cjs for why this is needed on some Node 22.x CI runners.
  resolver: '<rootDir>/jest.resolver.cjs',
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
