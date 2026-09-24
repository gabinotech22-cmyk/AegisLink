/**
 * Generated native sources of the Tor plugins stay compilable where we can
 * check them without Xcode/Gradle.
 *
 * Kotlin and Swift NEST block comments: a slash-star inside a block comment
 * (e.g. a KDoc mentioning a `/mailbox/<star>` path) opens a second comment,
 * and the file ends with an unclosed comment. That broke the Android build in
 * CI (Maestro job, 2026-09-23, AegisTorModule.kt "Unclosed comment"). This
 * test renders the template literals the plugins write and rejects any block
 * comment containing a nested opener.
 */
import * as fs from 'fs';
import * as path from 'path';

const PLUGINS = path.join(__dirname, '..', '..', 'plugins');
const BACKSLASH = String.fromCharCode(92);

/** Evaluate the template literal that follows `key` in a plugin file. */
function renderTemplate(file: string, key: string): string {
  const src = fs.readFileSync(path.join(PLUGINS, file), 'utf8');
  const start = src.indexOf(key);
  if (start < 0) throw new Error(`${key} not found in ${file}`);
  const i = src.indexOf('`', start);
  let j = i + 1;
  for (;;) {
    if (src[j] === BACKSLASH) { j += 2; continue; }
    if (src[j] === '`') break;
    j++;
  }
  // eslint-disable-next-line no-eval
  return (0, eval)(src.slice(i, j + 1)) as string;
}

/** Block comments that contain a nested opener (line comments are skipped). */
function nestedBlockComments(code: string): string[] {
  const bad: string[] = [];
  let k = 0;
  while (k < code.length) {
    if (code.startsWith('//', k)) { const nl = code.indexOf('\n', k); k = nl < 0 ? code.length : nl + 1; continue; }
    if (code[k] === '"') {
      // Skip a string literal on one line (enough for these sources).
      const end = code.indexOf('"', k + 1);
      k = end < 0 ? code.length : end + 1;
      continue;
    }
    if (code.startsWith('/*', k)) {
      const close = code.indexOf('*/', k + 2);
      const body = code.slice(k + 2, close < 0 ? code.length : close);
      if (body.includes('/*')) bad.push(body.slice(0, 120));
      k = close < 0 ? code.length : close + 2;
      continue;
    }
    k++;
  }
  return bad;
}

describe('Tor plugin native sources — no nested block comments (Kotlin/Swift nest them)', () => {
  it('Android AegisTorModule.kt', () => {
    expect(nestedBlockComments(renderTemplate('withTorEmbedded.js', "'AegisTorModule.kt':"))).toEqual([]);
  });
  it('iOS AegisTorLogic.swift', () => {
    expect(nestedBlockComments(renderTemplate('withTorEmbeddedIOS.js', 'const SWIFT_SOURCE ='))).toEqual([]);
  });
  it('the scanner catches the exact CI failure', () => {
    expect(nestedBlockComments('  /** /mailbox/* (stateless drain) */\n')).toHaveLength(1);
  });
});
