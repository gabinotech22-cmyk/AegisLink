// Global Jest mock for expo-secure-store.
//
// expo-secure-store is a native module: importing the real one in the Node test
// environment pulls in expo-modules-core's native bootstrap and crashes at load
// (e.g. "src/db/local.ts → expo-secure-store → expo-modules-core"). Like the
// other native modules in jest.config.js (expo-asset / expo-sqlite / expo-av),
// it is mapped to this in-memory stub. Tests that need specific behaviour can
// still override it with a local jest.mock('expo-secure-store', ...).
const store = new Map();

module.exports = {
  getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  setItemAsync: jest.fn(async (key, value) => { store.set(key, value); }),
  deleteItemAsync: jest.fn(async (key) => { store.delete(key); }),
  isAvailableAsync: jest.fn(async () => true),
  WHEN_UNLOCKED: 'whenUnlocked',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
};
