/**
 * Locale integrity — every key present in en.json exists in es/it with the same
 * {{placeholders}}, and every `i18n.t('…')` key referenced from the renderer
 * resolves in all three locales. Guards the desktop i18n port (2026-09): a
 * missing key silently renders the raw key path in the UI.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../locales/en.json';
import es from '../locales/es.json';
import itLocale from '../locales/it.json';

type Tree = { [k: string]: string | Tree };

function leaves(x: Tree, p = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === 'string') out[p + k] = v;
    else Object.assign(out, leaves(v, p + k + '.'));
  }
  return out;
}

const EN = leaves(en as Tree);
const ES = leaves(es as Tree);
const IT = leaves(itLocale as Tree);

function placeholders(s: string): string {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
}

// Known, deliberate divergence: the English plural hack `attempt{{v1}}` has no
// counterpart in es/it, which pluralise differently.
const PLACEHOLDER_EXCEPTIONS = new Set(['lock.incorrectPinV0Attempt']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, acc); }
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('desktop locales', () => {
  it('es and it contain every en key', () => {
    const missingEs = Object.keys(EN).filter((k) => !(k in ES));
    const missingIt = Object.keys(EN).filter((k) => !(k in IT));
    expect(missingEs).toEqual([]);
    expect(missingIt).toEqual([]);
  });

  it('interpolation placeholders match across languages', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(EN)) {
      if (PLACEHOLDER_EXCEPTIONS.has(k)) continue;
      for (const [lang, tree] of [['es', ES], ['it', IT]] as const) {
        if (k in tree && placeholders(tree[k]) !== placeholders(v)) bad.push(`${lang}:${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every i18n.t() key used by the renderer resolves in all locales', () => {
    const root = join(__dirname, '..', '..');
    const used = new Set<string>();
    for (const f of walk(root)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:i18n\.t|i18nT)\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(500);
    const missing = [...used].filter((k) => !(k in EN) || !(k in ES) || !(k in IT));
    expect(missing).toEqual([]);
  });
});
