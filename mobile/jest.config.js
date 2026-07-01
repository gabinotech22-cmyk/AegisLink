const path = require('path');

/** @type {import('jest-expo').JestPreset} */
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.tsx',
  ],
  transform: {
    // Local plugin lowers dynamic `import()` to `require()` so screens that
    // lazy-load modules can be rendered under Jest (see the plugin's header).
    '^.+\\.[jt]sx?$': [
      'babel-jest',
      {
        presets: ['babel-preset-expo'],
        plugins: [path.join(__dirname, 'jest/babel-transform-dynamic-import.js')],
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|tweetnacl|tweetnacl-util|@scure/base|@noble/hashes|@noble/post-quantum|@noble/ciphers|@noble/curves|react-native-reanimated|react-native-gesture-handler|expo-asset|expo-sqlite|expo-file-system)',
  ],
  setupFiles: [
    './node_modules/react-native-gesture-handler/jestSetup.js',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^expo-asset$': '<rootDir>/__mocks__/expo-asset.js',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.js',
    '^expo-sqlite$': '<rootDir>/__mocks__/expo-sqlite.js',
    '^expo-av$': '<rootDir>/__mocks__/expo-av.js',
    '^react-native-view-shot$': '<rootDir>/__mocks__/react-native-view-shot.js',
  },
};
