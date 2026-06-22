/**
 * Jazzer.js / OSS-Fuzz entry point for the `parseIdentityQR` parser target.
 * Generated thin wrapper — the actual logic + seed corpus live in
 * ../src/fuzz/targets.ts. See ./harness.js for the bundling contract.
 */
module.exports.fuzz = require('./harness').makeFuzz('parseIdentityQR');
