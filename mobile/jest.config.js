/** @type {import('jest-expo').JestPreset} */
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.tsx',
  ],
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|tweetnacl|tweetnacl-util|@scure/base|@noble/hashes|react-native-reanimated|react-native-gesture-handler)',
  ],
  setupFiles: [
    './node_modules/react-native-gesture-handler/jestSetup.js',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
