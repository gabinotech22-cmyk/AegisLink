/**
 * Leveled logger (M-5).
 *
 * Centralizes the ad-hoc `console.*` / `if (__DEV__) console.*` calls scattered
 * across the app behind a single, level-gated façade so diagnostic output is:
 *   - silent in production except `error` (no metadata, key prefixes, or
 *     who-talks-to-whom leaking to logcat),
 *   - controllable at runtime via {@link setLogLevel} for field debugging
 *     without a rebuild,
 *   - consistent (one place to reason about, instead of 130+ raw calls).
 *
 * Defense in depth: the production Babel build already strips `console.*`
 * (except `error`) via `transform-remove-console`. This adds a *runtime* gate on
 * top, so a stray dev/preview build — or a future change to that Babel config —
 * cannot start leaking. The two layers are independent on purpose.
 *
 * Callers that log secret material must still hash/truncate it themselves (see
 * the `[RDIAG]` key-fingerprint helpers) — the logger does not sanitize content.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// `__DEV__` is the React Native / Expo global — `false` in release bundles.
const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

// DIAGNOSTIC ESCAPE HATCH (throwaway diag builds ONLY — never ship). When the
// diag flag is baked in, a release-style build logs at 'debug' so field issues
// are visible in logcat. Paired with babel keeping console.* (see babel.config.js).
const IS_DIAG = process.env.EXPO_PUBLIC_AEGIS_DIAG === '1';

/** Default: everything in dev/diag, silent in production to prevent metadata leakage. */
const DEFAULT_LEVEL: LogLevel = IS_DEV || IS_DIAG ? 'debug' : 'silent';

let currentLevel: LogLevel = DEFAULT_LEVEL;

/** Raise or lower the verbosity at runtime (e.g. from a hidden debug toggle). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return ORDER[level] >= ORDER[currentLevel];
}

export const logger = {
  /** Verbose dev tracing. Stripped from prod bundles AND gated at runtime. */
  debug: (...args: unknown[]): void => {
    if (enabled('debug')) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    if (enabled('info')) console.info(...args);
  },
  warn: (...args: unknown[]): void => {
    if (enabled('warn')) console.warn(...args);
  },
  /** Survives production builds (still gated by level, default-enabled). */
  error: (...args: unknown[]): void => {
    if (enabled('error')) console.error(...args);
  },
};
