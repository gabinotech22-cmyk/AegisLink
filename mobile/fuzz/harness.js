/**
 * Shared Jazzer.js harness factory for the AegisLink parser fuzz targets.
 *
 * The targets themselves live in TypeScript (`../src/fuzz/targets.ts`) and are
 * shared verbatim with the always-on in-repo Jest campaign. For coverage-guided
 * fuzzing we bundle that file (+ its pure-logic closure) to a single CommonJS
 * file with esbuild — see `infra/oss-fuzz/build.sh` and the `fuzz:bundle` npm
 * script. esbuild erases the type-only imports and inlines tweetnacl/@noble, so
 * the bundle has NO React-Native / Expo runtime dependency and runs standalone
 * under Jazzer.
 *
 * Contract under fuzz: each target must FAIL SOFT (return null / a typed
 * "not a match"). Under Jazzer an uncaught throw IS the finding, so — unlike a
 * try/catch app path — the harness does NOT swallow errors: it lets them
 * propagate to the fuzzer.
 */
const { FUZZ_TARGETS } = require('./targets.bundle.js');

/**
 * Build a Jazzer `fuzz(data: Buffer)` entry point for a named target.
 * @param {string} name one of the FUZZ_TARGETS names
 */
function makeFuzz(name) {
  const target = FUZZ_TARGETS.find((t) => t.name === name);
  if (!target) {
    throw new Error(
      `unknown fuzz target "${name}" — known: ${FUZZ_TARGETS.map((t) => t.name).join(', ')}`,
    );
  }
  // Jazzer hands us a Buffer. The targets take a string (the same surface the
  // in-repo campaign fuzzes); decode as UTF-8. Byte-oriented targets re-encode
  // internally, so this keeps mobile↔OSS-Fuzz parity on the exact code path.
  return (data) => {
    target.run(data.toString('utf8'));
  };
}

module.exports = { makeFuzz, FUZZ_TARGETS };
