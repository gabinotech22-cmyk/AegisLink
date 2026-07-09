/**
 * iOS audit 2026-07-09 follow-ups — regression tests.
 *
 * #5: LockSetup's biometric-enable prompt (LocalAuthentication.authenticateAsync)
 * backgrounds the app on iOS ('inactive'); with the default lock timeout
 * ("Immediately") App.tsx's lock handler would re-lock the app when the prompt
 * closes. The call must stay wrapped in withPickingGuard so isPicking()
 * suppresses the lock. (Lock.tsx was fixed separately via PIN-first in PR #282.)
 *
 * #9: ice.ts uses iceTransportPolicy 'all', which gathers local-network host
 * candidates; iOS 14+ requires NSLocalNetworkUsageDescription or calls silently
 * degrade to TURN-only. Same source-text style as
 * appFilePickers.pickingGuard.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');

describe('LockSetup — biometric enable prompt is wrapped in withPickingGuard', () => {
  const src = fs.readFileSync(
    path.join(MOBILE_ROOT, 'src', 'screens', 'LockSetup.tsx'),
    'utf8'
  );

  it('imports withPickingGuard', () => {
    expect(src).toMatch(/import \{ withPickingGuard \} from '\.\.\/utils\/pickingGuard'/);
  });

  it('wraps LA.authenticateAsync in withPickingGuard inside handleToggleBiometrics', () => {
    const start = src.indexOf('const handleToggleBiometrics');
    const end = src.indexOf('const handleToggleLock', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const guardIdx = body.indexOf('withPickingGuard(');
    const authIdx = body.indexOf('LA.authenticateAsync(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(guardIdx);
  });
});

describe('app.json — iOS local network usage description for WebRTC host candidates', () => {
  const appJson = JSON.parse(
    fs.readFileSync(path.join(MOBILE_ROOT, 'app.json'), 'utf8')
  ) as { expo: { ios: { infoPlist: Record<string, unknown> } } };

  it('declares NSLocalNetworkUsageDescription', () => {
    const desc = appJson.expo.ios.infoPlist.NSLocalNetworkUsageDescription;
    expect(typeof desc).toBe('string');
    expect((desc as string).length).toBeGreaterThan(20);
  });
});
