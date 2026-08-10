/**
 * Every screen must be wired to i18n.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-08 audit found five screens — ProfileSwitcher, CreateProfile,
 * Scheduled, DistributionLists, BroadcastCompose — with no `useTranslation` at
 * all: roughly 41 hardcoded literals, and in mixed languages. A Spanish user got
 * every call error in English; an English user got the profile switcher and the
 * scheduled list in Spanish.
 *
 * The existing locale suites could not catch that. `i18nKeyParity` and
 * `localeParity` check that en/es/it hold the SAME KEYS — they say nothing about
 * whether a screen reaches for a key instead of typing a string. Three green
 * locale files next to five untranslated screens is exactly the kind of false
 * comfort worth removing.
 *
 * This is deliberately a coarse structural check, not a string linter: a screen
 * either imports the translation hook or it does not. Cheap, zero false
 * negatives for the failure mode that actually happened, and it fails the moment
 * someone adds a screen and forgets.
 *
 * A screen with genuinely no user-facing text can be added to ALLOWED_WITHOUT_I18N
 * below — with a reason, so the exemption is a decision and not a shrug.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCREENS_DIR = path.join(__dirname, '..', '..', 'screens');

/**
 * Screens that legitimately render no translatable text. Keep this list short
 * and justified — every entry is a hole in the check.
 *
 * Currently EMPTY, and that is the point: as of the 2026-08 audit every single
 * screen is wired. Adding an entry here should feel like a decision, not a way
 * to make a red test go away.
 */
const ALLOWED_WITHOUT_I18N: Record<string, string> = {};

function screenFiles(): string[] {
  return fs
    .readdirSync(SCREENS_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .sort();
}

describe('every screen is wired to i18n', () => {
  it('finds screens to check (guards against a bad path silently passing)', () => {
    // Without this, a wrong SCREENS_DIR would make the suite below vacuously
    // green — the failure mode this whole file exists to prevent.
    expect(screenFiles().length).toBeGreaterThan(20);
  });

  it.each(screenFiles())('%s imports useTranslation', (file) => {
    if (ALLOWED_WITHOUT_I18N[file]) return;
    const src = fs.readFileSync(path.join(SCREENS_DIR, file), 'utf8');
    expect(src).toContain('useTranslation');
  });

  it('has no stale exemptions', () => {
    // An exemption for a file that no longer exists hides the next screen that
    // happens to be named the same.
    const present = new Set(screenFiles());
    for (const f of Object.keys(ALLOWED_WITHOUT_I18N)) {
      expect(present.has(f)).toBe(true);
    }
  });
});

// ─── Alerts, anywhere in src/ ────────────────────────────────────────────────
//
// The screen check above was not enough, and CI proved it: the E2E screenshot
// of a failed run showed the banner "Registro fallido" on an en_US emulator.
// That string lives in store/identity.ts, not in a screen — along with seven
// more in socket/groupCalls.ts, components/SchedulePicker.tsx and
// socket/client.ts. Alerts are the most user-visible text in the app and the
// easiest to hardcode, because they are written far from any JSX.
//
// So this walks ALL of src/ and fails on a themedAlert whose first argument is
// a bare string literal. A translated call passes t('…') / i18nT('…') /
// i18n.t('…'), never a quote.

const SRC_DIR = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '_unused') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('no hardcoded alert copy anywhere in src/', () => {
  it('every themedAlert title goes through i18n', () => {
    // A quote right after the paren is a literal; anything else is an expression.
    const LITERAL_FIRST_ARG = /themedAlert\(\s*['"`]/;
    const offenders: string[] = [];

    for (const file of walk(SRC_DIR)) {
      // AlertHost defines themedAlert and documents it with a literal example.
      if (path.basename(file) === 'AlertHost.tsx') continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (LITERAL_FIRST_ARG.test(line)) {
          offenders.push(`${path.relative(SRC_DIR, file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
