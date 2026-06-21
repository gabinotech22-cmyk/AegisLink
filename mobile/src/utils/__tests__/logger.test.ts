/**
 * logger — unit tests (M-5)
 *
 * Verifies the level gate routes to the right console method and suppresses
 * below-threshold output, including a fully-silent mode.
 */
import { logger, setLogLevel, getLogLevel } from '../logger';

describe('logger', () => {
  let logSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setLogLevel('debug'); // reset for isolation
  });

  it('routes each method to its console counterpart at debug level', () => {
    setLogLevel('debug');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(logSpy).toHaveBeenCalledWith('d');
    expect(infoSpy).toHaveBeenCalledWith('i');
    expect(warnSpy).toHaveBeenCalledWith('w');
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('suppresses below-threshold levels at "warn"', () => {
    setLogLevel('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('w');
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('at "error" only errors pass', () => {
    setLogLevel('error');
    logger.debug('d');
    logger.warn('w');
    logger.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('e');
  });

  it('"silent" suppresses everything including errors', () => {
    setLogLevel('silent');
    logger.debug('d');
    logger.warn('w');
    logger.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('forwards multiple arguments verbatim', () => {
    setLogLevel('debug');
    const err = new Error('boom');
    logger.warn('[socket] failed', 3, err);
    expect(warnSpy).toHaveBeenCalledWith('[socket] failed', 3, err);
  });

  it('exposes the current level', () => {
    setLogLevel('info');
    expect(getLogLevel()).toBe('info');
  });
});
