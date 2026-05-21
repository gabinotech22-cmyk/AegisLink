'use strict';

// Mock for node:sqlite — used in Jest tests so the DB layer
// doesn't require a real SQLite file during CI.
class DatabaseSync {
  constructor() {
    this._stmts = new Map();
  }
  exec() {}
  prepare(sql) {
    if (!this._stmts.has(sql)) {
      this._stmts.set(sql, {
        run: jest.fn().mockReturnValue({ changes: 1 }),
        get: jest.fn().mockReturnValue(undefined),
        all: jest.fn().mockReturnValue([]),
      });
    }
    return this._stmts.get(sql);
  }
  close() {}
}

module.exports = { DatabaseSync };
