/**
 * Regression: the alternate-app-icon feature never worked because app.json
 * handed the plugin `{ icons: [...] }` while expo-alternate-app-icons expects a
 * plain array (it silently no-ops on anything without `.length`), lowercase
 * names (the plugin PascalCases them, so the JS side asked for `light` and the
 * OS only knew `Light`) and a string for `android` (the generator destructures
 * `{ foregroundImage }` and skips when it is undefined). This test pins the
 * shape the plugin actually consumes and keeps the screen in sync with it.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ALL_VARIANTS, variantFromNativeName } from '../AppIcon';

jest.mock('expo-alternate-app-icons', () => ({
  supportsAlternateIcons: true,
  getAppIconName: () => null,
  setAlternateAppIcon: jest.fn(),
}));

type PluginIcon = { name: string; ios: string; android: { foregroundImage: string; backgroundColor: string } };

function pluginProps(): PluginIcon[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const appJson = require('../../../app.json') as { expo: { plugins: unknown[] } };
  const entry = appJson.expo.plugins.find(
    (p) => Array.isArray(p) && p[0] === 'expo-alternate-app-icons',
  ) as [string, unknown] | undefined;
  if (!entry) throw new Error('expo-alternate-app-icons plugin missing from app.json');
  return entry[1] as PluginIcon[];
}

describe('expo-alternate-app-icons config', () => {
  it('is an array of PascalCase icons with adaptive android layers that exist', () => {
    const props = pluginProps();
    expect(Array.isArray(props)).toBe(true);
    expect(props.length).toBeGreaterThan(0);
    const root = resolve(__dirname, '../../..');
    for (const icon of props) {
      expect(icon.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      expect(typeof icon.ios).toBe('string');
      expect(existsSync(resolve(root, icon.ios))).toBe(true);
      expect(typeof icon.android).toBe('object');
      expect(existsSync(resolve(root, icon.android.foregroundImage))).toBe(true);
      expect(icon.android.backgroundColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('every non-default variant on the screen maps to a configured icon name', () => {
    const names = new Set(pluginProps().map((i) => i.name));
    for (const v of ALL_VARIANTS) {
      if (v.native === null) continue;
      expect(names.has(v.native)).toBe(true);
    }
    expect(ALL_VARIANTS.filter((v) => v.native === null)).toHaveLength(1);
  });

  it('maps native names back to variants, unknown → default', () => {
    expect(variantFromNativeName(null)).toBe('default');
    expect(variantFromNativeName(undefined)).toBe('default');
    expect(variantFromNativeName('Light')).toBe('light');
    expect(variantFromNativeName('Tinted')).toBe('tinted');
    expect(variantFromNativeName('light')).toBe('default');
  });
});
