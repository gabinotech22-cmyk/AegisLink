import fs from 'fs';
import path from 'path';
import en from '../locales/en.json';
import es from '../locales/es.json';
import itLocale from '../locales/it.json';

/**
 * Regression for the Notifications.tsx bug (2026-07): a screen called
 * i18nT('notifications.masterSub', 'Master switch...') etc. with keys that
 * were never added to the locale catalogs. Since i18next silently falls
 * back to the literal English (or, worse, whatever language the developer
 * happened to type) default string when a key is missing, non-English
 * devices silently showed the wrong language with no error anywhere.
 *
 * This test statically scans every .ts/.tsx file under src/ for i18nT(...)
 * (and bare `t(...)`) calls with a string-literal namespaced key
 * ("namespace.key.path") and asserts that key exists in all three locale
 * catalogs. It also asserts the three catalogs share exactly the same key
 * set (belt-and-suspenders with localeParity.test.ts).
 */

type LocaleTree = { [key: string]: string | LocaleTree };

function flattenKeys(obj: LocaleTree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const p = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [p] : flattenKeys(value as LocaleTree, p);
  });
}

const SRC_DIR = path.resolve(__dirname, '../../../src');

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
}

// Matches i18nT('ns.key', ...) or a bare t('ns.key', ...) call (react-i18next's
// `t` from useTranslation()), capturing the dotted key as group 1.
const KEY_CALL_RE = /(?:i18nT|[^a-zA-Z0-9_.]t)\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)['"]/g;

function extractUsedKeys(): Map<string, Set<string>> {
  const files: string[] = [];
  walk(SRC_DIR, files);

  const usages = new Map<string, Set<string>>();
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    KEY_CALL_RE.lastIndex = 0;
    while ((match = KEY_CALL_RE.exec(content))) {
      const key = match[1];
      const rel = path.relative(SRC_DIR, file);
      if (!usages.has(key)) usages.set(key, new Set());
      usages.get(key)!.add(rel);
    }
  }
  return usages;
}

const locales: Record<string, LocaleTree> = { en, es, it: itLocale };
const flatByLocale: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(locales).map(([loc, tree]) => [loc, new Set(flattenKeys(tree))]),
);

/**
 * A key is considered present if it exists literally, or if it's a
 * pluralized base key resolved by i18next's automatic `_one`/`_other`
 * suffix lookup when the caller passes `{ count }` (e.g. `search.member`
 * resolving via `search.member_one` / `search.member_other`).
 */
function keyExists(key: string, keys: Set<string>): boolean {
  return keys.has(key) || keys.has(`${key}_one`) || keys.has(`${key}_other`);
}

describe('i18n key usage parity (static source scan)', () => {
  const usages = extractUsedKeys();

  it('found a non-trivial number of i18nT usages (sanity check the scan itself works)', () => {
    expect(usages.size).toBeGreaterThan(100);
  });

  it.each(Object.keys(locales))('every i18nT key used in source exists in %s.json', (loc) => {
    const keys = flatByLocale[loc];
    const missing: string[] = [];
    for (const [key, files] of usages) {
      if (!keyExists(key, keys)) {
        missing.push(`${key}  (used in: ${[...files].join(', ')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('all three locale catalogs expose the exact same key set', () => {
    const enKeys = [...flatByLocale.en].sort();
    for (const loc of ['es', 'it']) {
      expect([...flatByLocale[loc]].sort()).toEqual(enKeys);
    }
  });
});
