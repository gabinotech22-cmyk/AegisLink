/**
 * Manual mock for expo-file-system/legacy, wired via moduleNameMapper.
 *
 * Why a mapper instead of per-suite jest.mock(): in CI (full parallel suite,
 * Linux workers) jest-expo's setup can pull the REAL module into the registry
 * BEFORE a test file's jest.mock() factories register, making them a no-op for
 * the already-cached instance (media.test.ts failed 12/12 this way while
 * passing locally). A moduleNameMapper resolves at path-resolution time, so
 * whatever gets cached IS this mock — load order can no longer matter.
 *
 * Suites keep full control: a suite-level jest.mock('expo-file-system/legacy')
 * factory still overrides this file, and suites without one get these benign
 * defaults. Tests can also require() this module directly and program the
 * jest.fn()s per test (see media.test.ts).
 */
module.exports = {
  cacheDirectory: 'file://cache/',
  documentDirectory: 'file://docs/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT', MULTIPART: 'MULTIPART' },
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  readAsStringAsync: jest.fn().mockResolvedValue(''),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  moveAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  downloadAsync: jest.fn().mockResolvedValue({ status: 200, uri: 'file://cache/download' }),
  uploadAsync: jest.fn().mockResolvedValue({ status: 200, body: '{}' }),
};
