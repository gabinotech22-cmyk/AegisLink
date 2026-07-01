const path = require('path');

/**
 * Dedicated Jest config for the parser fuzz campaign (src/fuzz).
 *
 * The fuzz targets (crypto/qr, utils/attachmentFormat, utils/groupPost,
 * utils/parseLocationMessage, crypto/metadata) are pure TS: their only runtime
 * dependency is tweetnacl-util plus the TextEncoder/TextDecoder globals. They do
 * NOT import expo or react-native.
 *
 * So this config deliberately omits `preset: 'jest-expo'`. The jest-expo preset
 * loads Expo SDK 54's "winter" runtime, which installs web globals lazily via a
 * Proxy that `require()`s the polyfill on first access. Under Jest 30 that
 * mid-execution require() is rejected (`throwIfBetweenTests`: "trying to require
 * a file outside of the scope of the test code"), crashing the whole suite when
 * a parser first touches TextDecoder. Running preset-free means TextEncoder/
 * TextDecoder resolve to Node's native globals — no Proxy, no lazy require — so
 * the campaign runs identically under Node 22 (CI) and locally, on jest 29 or 30.
 *
 * The babel *transform* (babel-preset-expo) is kept: it only compiles TS at
 * build time and does not pull in the winter runtime.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/fuzz/**/*.test.ts'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'babel-jest',
      {
        presets: ['babel-preset-expo'],
        plugins: [path.join(__dirname, 'jest/babel-transform-dynamic-import.js')],
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(tweetnacl|tweetnacl-util)/)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
