'use strict';

// In-memory SQLite mock for Jest CI — maintains per-table state so
// auth tests can insert and retrieve rows within the same test run.

class DatabaseSync {
  constructor() {
    this._tables = {};
  }

  exec(sql) {
    // Extract table names from CREATE TABLE statements and initialise them.
    const matches = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)];
    for (const m of matches) {
      const table = m[1].toLowerCase();
      if (!this._tables[table]) this._tables[table] = [];
    }
  }

  prepare(sql) {
    const db = this;
    const sqlU = sql.trim().toUpperCase();

    if (sqlU.startsWith('INSERT')) {
      const tableMatch = sql.match(/INTO\s+(\w+)/i);
      const table = tableMatch ? tableMatch[1].toLowerCase() : '__unknown';
      return {
        run: jest.fn((...args) => {
          if (!db._tables[table]) db._tables[table] = [];
          // Store args as a row object keyed by position
          db._tables[table].push({ _args: args, _sql: sql });
          return { changes: 1, lastInsertRowid: db._tables[table].length };
        }),
      };
    }

    if (sqlU.startsWith('SELECT')) {
      const tableMatch = sql.match(/FROM\s+(\w+)/i);
      const table = tableMatch ? tableMatch[1].toLowerCase() : '__unknown';
      return {
        get: jest.fn((...args) => {
          const rows = db._tables[table] || [];
          // Return last inserted row as a plain object so tests can
          // access columns — challenges are keyed by aegis_id (first arg).
          if (rows.length === 0) return undefined;
          // Build a synthetic row that satisfies auth/challenge.ts usage:
          // identityRepo.get returns { public_key_b64 }
          // challengeStore.get returns the stored challenge fields
          const last = rows[rows.length - 1];
          return last._row || last;
        }),
        all: jest.fn(() => (db._tables[table] || []).map(r => r._row || r)),
      };
    }

    if (sqlU.startsWith('DELETE') || sqlU.startsWith('UPDATE')) {
      const tableMatch = sql.match(/(FROM|UPDATE)\s+(\w+)/i);
      const table = tableMatch ? tableMatch[2].toLowerCase() : '__unknown';
      return {
        run: jest.fn(() => { db._tables[table] = []; return { changes: 1 }; }),
      };
    }

    // Fallback
    return {
      run: jest.fn().mockReturnValue({ changes: 1 }),
      get: jest.fn().mockReturnValue(undefined),
      all: jest.fn().mockReturnValue([]),
    };
  }

  close() {}
}

module.exports = { DatabaseSync };
