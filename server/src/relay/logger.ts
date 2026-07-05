// Minimal structured logger for the relay. Never pass raw Error/exception
// objects or connection strings to a sink — only short, pre-extracted fields
// (message/code), matching the "no metadata, no secrets in logs" rule.
// Info-level output is suppressed outside development so production stays
// quiet (golden rule: no console.log in production); errors always surface
// since operators need them to notice outages, but only as safe strings.
const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
  info(message: string): void {
    if (isDev) console.log(`[relay] ${message}`);
  },
  error(message: string, meta?: Record<string, string>): void {
    console.error(`[relay] ${message}`, meta ?? {});
  },
};
