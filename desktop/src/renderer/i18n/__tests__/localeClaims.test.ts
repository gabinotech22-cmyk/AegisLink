/**
 * Honesty-of-claims regression test (parity with mobile
 * src/__tests__/audit-regression.test.ts, "Honesty of claims" block).
 *
 * Bug: the onboarding footer shipped "AUDITED 2026 Q1" / "AUDITADO 2026 Q1" /
 * "VERIFICATO 2026 Q1" on the very first screen, but no independent third-party
 * audit has happened (it is a Phase 2 goal — docs/ANDROID-LAUNCH-READINESS.md,
 * "Honestidad de claims"). Marketing claims must have verifiable backing:
 * "auditable" and "audit pending" are honest, "audited" is not until the
 * report exists.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve(__dirname, '..', 'locales');
const localeFiles = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

function flattenStrings(node: unknown, prefix: string, out: Array<{ key: string; value: string }>): void {
  if (typeof node === 'string') {
    out.push({ key: prefix, value: node });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      flattenStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

describe('locales never claim a completed third-party audit', () => {
  it('covers every locale file', () => {
    expect(localeFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(localeFiles)('%s contains no past-tense audit claim in any string', (file) => {
    const json = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8')) as unknown;
    const strings: Array<{ key: string; value: string }> = [];
    flattenStrings(json, '', strings);
    // "audited"/"auditado"/"auditada"/"auditato" claim a completed audit;
    // "audit", "auditable", "auditoría" (log/pending/row labels) stay legal.
    const offenders = strings.filter((s) => /\baudit(ed|ado|ada|ato)\b/i.test(s.value));
    expect(offenders).toEqual([]);
  });

  it.each(localeFiles)('%s onboarding.footer makes no audit/verification claim', (file) => {
    const json = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8')) as {
      onboarding?: { footer?: string };
    };
    const footer = json.onboarding?.footer ?? '';
    expect(footer).not.toEqual('');
    // The footer may say an audit is pending/planned, but never that one was
    // done ("AUDITED/AUDITADO/VERIFICATO <year>"). A year next to the claim is
    // the tell of a completed-audit assertion.
    expect(footer).not.toMatch(/(audit\w*|verifi\w*|certifi\w*)\s*(20\d\d|Q[1-4])/i);
    expect(footer).not.toMatch(/\baudit(ed|ado|ada|ato)\b/i);
    expect(footer).not.toMatch(/\bverificat[oa]\b|\bverified\b|\bverificad[oa]\b/i);
  });
});
