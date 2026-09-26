/**
 * Hito 5 guard: renderer code logs only through `utils/logger.ts`, which gates
 * every level (debug/info default-off in production). A bare `console.*` call
 * would bypass that gate and could print ratchet counters, key fingerprints or
 * contact ids in a production build. The desktop has no ESLint, so this scans
 * the source like `crypto/__tests__/crypto-imports.test.ts` does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const RENDERER = path.resolve(__dirname, '../..');
const LOGGER = path.join(RENDERER, 'utils', 'logger.ts');
// A call, not a mention in a comment: `console.log(`, `console.warn (`, …
const CONSOLE_CALL = /(^|[^\w.$])console\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\s*\(/;

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') productionFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Source with // and /* *\/ comments blanked, so commented-out calls do not count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no bare console.* in the renderer', () => {
  it('every log goes through utils/logger', () => {
    const offenders = productionFiles(RENDERER)
      .filter((p) => p !== LOGGER)
      .filter((p) => CONSOLE_CALL.test(stripComments(fs.readFileSync(p, 'utf8'))))
      .map((p) => path.relative(RENDERER, p));
    expect(offenders).toEqual([]);
  });

  it('the scan catches a real call and ignores comments', () => {
    expect(CONSOLE_CALL.test(stripComments("if (x) console.warn('a');"))).toBe(true);
    expect(CONSOLE_CALL.test(stripComments('// console.log(secret)'))).toBe(false);
    expect(CONSOLE_CALL.test(stripComments('/* console.error(x) */'))).toBe(false);
    expect(CONSOLE_CALL.test(stripComments('logger.warn(x)'))).toBe(false);
  });
});
