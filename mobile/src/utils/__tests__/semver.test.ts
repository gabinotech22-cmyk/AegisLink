import { compareVersions, isOlderThan } from '../semver';

describe('semver — x.y.z comparison for the version notice', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.0.6', '1.0.6')).toBe(0);
    expect(isOlderThan('1.0.6', '1.0.6')).toBe(false);
  });

  it('isOlderThan is strict', () => {
    expect(isOlderThan('1.0.5', '1.0.6')).toBe(true);
    expect(isOlderThan('1.0.6', '1.0.5')).toBe(false);
  });

  it('parses garbage as 0.0.0 so a bad relay value can never trigger a gate', () => {
    // installed '1.0.6' vs garbage target → not older → no banner, no block
    expect(isOlderThan('1.0.6', 'v1.0.7')).toBe(false);
    expect(isOlderThan('1.0.6', '1.0.7-rc1')).toBe(false);
    expect(isOlderThan('1.0.6', '')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(compareVersions(' 1.0.6 ', '1.0.6')).toBe(0);
  });
});
