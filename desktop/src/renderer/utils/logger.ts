/**
 * Leveled logger — desktop renderer port of the mobile logger (M-5 / audit M3).
 *
 * Centralizes the ad-hoc `console.*` calls scattered across the renderer behind a
 * single, level-gated façade so diagnostic output is:
 *   - silent in production except `error` (no metadata, key prefixes, or
 *     who-talks-to-whom leaking to the devtools console / log files),
 *   - controllable at runtime via {@link setLogLevel} for field debugging
 *     without a rebuild,
 *   - consistent (one place to reason about).
 *
 * Kept API-identical to `mobile/src/utils/logger.ts` on purpose (parity).
 * Callers that log secret material must still hash/truncate it themselves — the
 * logger does not sanitize content.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// Vite renderer: `import.meta.env.DEV` is `false` in packaged production builds.
const IS_DEV = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

/** Default: everything in dev, errors-only in production. */
const DEFAULT_LEVEL: LogLevel = IS_DEV ? 'debug' : 'error';

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
  /** Verbose dev tracing. Gated at runtime; default-off in production. */
  debug: (...args: unknown[]): void => {
    // nosemgrep: semgrep.aegislink-no-console-log-production
    if (enabled('debug')) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    // nosemgrep: semgrep.aegislink-no-console-log-production
    if (enabled('info')) console.info(...args);
  },
  warn: (...args: unknown[]): void => {
    // nosemgrep: semgrep.aegislink-no-console-log-production
    if (enabled('warn')) console.warn(...args);
  },
  /** Survives production builds (still gated by level, default-enabled). */
  error: (...args: unknown[]): void => {
    // nosemgrep: semgrep.aegislink-no-console-log-production
    if (enabled('error')) console.error(...args);
  },
};
