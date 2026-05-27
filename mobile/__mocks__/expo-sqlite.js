// Jest manual mock for expo-sqlite — stubs native SQLite module
const mockDb = {
  execAsync: jest.fn(async () => undefined),
  runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
  getAllAsync: jest.fn(async () => []),
  getFirstAsync: jest.fn(async () => null),
  withTransactionAsync: jest.fn(async (fn) => fn()),
  closeAsync: jest.fn(async () => undefined),
};

module.exports = {
  openDatabaseAsync: jest.fn(async () => mockDb),
  openDatabaseSync: jest.fn(() => mockDb),
  SQLiteDatabase: jest.fn(),
  useSQLiteContext: jest.fn(() => mockDb),
  SQLiteProvider: ({ children }) => children,
};
