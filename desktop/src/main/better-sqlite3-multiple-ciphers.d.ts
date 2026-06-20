// better-sqlite3-multiple-ciphers is an API-compatible drop-in for better-sqlite3
// (adds SQLCipher/cipher PRAGMAs). It ships no own types, so reuse the
// @types/better-sqlite3 declarations for the value/namespace import.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('better-sqlite3');
  export = Database;
}
