// Jest manual mock for expo-asset — prevents native module resolution
module.exports = {
  Asset: {
    fromModule: jest.fn(() => ({ downloadAsync: jest.fn() })),
    loadAsync: jest.fn(),
  },
  useAssets: jest.fn(() => [null, null]),
};
