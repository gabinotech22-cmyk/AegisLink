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
do not swallow errors. A Jazzer harness is a one-liner per target:

```js
// parseIdentityQR.fuzz.js
const { FUZZ_TARGETS } = require('../src/fuzz/targets');
const t = FUZZ_TARGETS.find((x) => x.name === 'parseIdentityQR');
module.exports.fuzz = (data /* Buffer */) => t.run(data.toString('utf8'));
```

For OSS-Fuzz, the `projects/aegislink/` entry needs `project.yaml`
(`language: javascript`), a `Dockerfile` (clone repo, `npm ci` in `mobile/`),
and a `build.sh` that runs `compile_javascript_fuzzer mobile <target>.fuzz.js`
for each target, seeding the corpus from each target's `seeds`.
