# Parser fuzzing

Coverage of the untrusted-input parsers — the functions that turn an
attacker-controlled string (a scanned QR, a pasted invite link, a message body
arriving from the relay) into structured data. Their contract is to **fail
soft**: return `null` / a typed "not a match" result, never throw, never hang.

## Targets

Declared in [`targets.ts`](./targets.ts):

| target | input source | contract |
|--------|--------------|----------|
| `parseIdentityQR` | scanned QR / deep link | `ParsedIdentityQR \| null` |
| `parseGroupInviteLink` | scanned QR / invite link | `ParsedGroupInvite \| null` |
| `universalToScheme` | pasted https link | `string \| null` |
| `parseMultiPayload` | message body (relay) | `{…} \| null` |
| `parseGroupPostMarker` | message body (relay) | typed result |
| `parseLocationMessage` | message body (relay) | `{…} \| null` |
| `unpadInnerPayload` | decrypted ratchet payload (malicious peer) | `{…} \| null` |

## Run it (in-repo, always-on CI gate)

A deterministic, native-dependency-free campaign (seeded PRNG → structure-aware
mutation) lives in [`__tests__/parsers.fuzz.test.ts`](./__tests__/parsers.fuzz.test.ts).
It runs in plain Jest, so it works on Windows/macOS/Linux and gates every PR:

```bash
cd mobile
npm run fuzz           # = jest src/fuzz --maxWorkers=1
```

On a finding it prints a copy-pasteable `repro (JSON)` string; turn it into a
unit regression next to the parser (see the malformed-percent-encoding cases in
`src/crypto/__tests__/qr.links.test.ts`, found this way).

## Run it under Jazzer.js (coverage-guided / OSS-Fuzz)

The same `run(input)` functions are valid [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)
entry points — there an uncaught throw IS the finding, which is why the targets
do not swallow errors. The harnesses live in [`mobile/fuzz/`](../../fuzz/): a
thin `<target>.fuzz.js` per target plus a shared `harness.js`. They load a
single esbuild bundle of `targets.ts` (+ its pure closure — no RN/Expo runtime
dependency survives), so they run standalone:

```bash
cd mobile
npm run fuzz:bundle      # esbuild → fuzz/targets.bundle.js (gitignored)
# then drive any target with Jazzer, e.g.:
npx jazzer fuzz/parseIdentityQR.fuzz.js
```

### OSS-Fuzz integration

The `projects/aegislink/` entry for [google/oss-fuzz](https://github.com/google/oss-fuzz)
is kept in-tree at [`infra/oss-fuzz/`](../../../infra/oss-fuzz/) so it's
versioned with the code it exercises — the OSS-Fuzz PR is a copy of that
directory:

- `project.yaml` — `language: javascript`, libFuzzer engine, `none` sanitizer.
- `Dockerfile` — `base-builder-javascript`, shallow-clones the repo.
- `build.sh` — `npm ci --ignore-scripts` in `mobile/`, bundles, then
  `compile_javascript_fuzzer` for each target and zips its `seeds` as the
  seed corpus.

When you add a target to `FUZZ_TARGETS`, also add a `mobile/fuzz/<name>.fuzz.js`
wrapper and the name to the `TARGETS` list in `infra/oss-fuzz/build.sh`.
