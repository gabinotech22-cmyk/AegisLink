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
