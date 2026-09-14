import { appVersionInfo } from '../relay/appVersion';

describe('appVersionInfo — relay-side version advertisement', () => {
  it('returns undefined when nothing is configured (no gate by default)', () => {
    expect(appVersionInfo({})).toBeUndefined();
    expect(appVersionInfo({ APP_LATEST_VERSION: '', APP_MIN_VERSION: '   ' })).toBeUndefined();
  });

  it('publishes both values when set', () => {
    expect(appVersionInfo({ APP_LATEST_VERSION: '1.0.6', APP_MIN_VERSION: '1.0.6' }))
      .toEqual({ latestVersion: '1.0.6', minVersion: '1.0.6' });
  });

  it('publishes each value independently', () => {
    expect(appVersionInfo({ APP_LATEST_VERSION: '1.0.7' })).toEqual({ latestVersion: '1.0.7' });
    expect(appVersionInfo({ APP_MIN_VERSION: '1.0.6' })).toEqual({ minVersion: '1.0.6' });
  });

  it('drops a malformed value instead of shipping it (a typo must never lock users out)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(appVersionInfo({ APP_LATEST_VERSION: '1.0.6', APP_MIN_VERSION: 'v1.0' }))
      .toEqual({ latestVersion: '1.0.6' });
    expect(appVersionInfo({ APP_MIN_VERSION: '1.0.6-rc1' })).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('trims whitespace from .env values', () => {
    expect(appVersionInfo({ APP_LATEST_VERSION: ' 1.0.6 ' })).toEqual({ latestVersion: '1.0.6' });
  });
});
