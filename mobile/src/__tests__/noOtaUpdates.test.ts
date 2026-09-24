/**
 * OTA code updates are OFF (decided 2026-09-24).
 *
 * expo-updates checked u.expo.dev on every launch over clearnet, outside Tor,
 * with a stable install id: Expo saw the device IP and that AegisLink is
 * installed. It was also a channel that could push new code to every phone
 * without store review. Every code change now ships in a store build.
 *
 * These guards stop it from coming back by accident: the config must keep the
 * updates system disabled, and no code may call the expo-updates API.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

describe('OTA updates stay disabled', () => {
  it('app.json: updates disabled and never checked automatically', () => {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')) as {
      expo: { updates?: { enabled?: boolean; checkAutomatically?: string } };
    };
    expect(app.expo.updates?.enabled).toBe(false);
    expect(app.expo.updates?.checkAutomatically).toBe('NEVER');
  });

  it('no production code imports or calls expo-updates', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/from ['"]expo-updates['"]|require\(['"]expo-updates['"]\)/.test(src)) offenders.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'src'));
    const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
    if (/expo-updates/.test(app)) offenders.push('App.tsx');
    expect(offenders).toEqual([]);
  });
});
