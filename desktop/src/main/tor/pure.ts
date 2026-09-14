/**
 * Electron-free helpers for the Tor layer, split out so vitest (plain Node
 * environment, no `electron` module) can cover them directly.
 */

const BOOTSTRAP_RE = /Bootstrapped (\d{1,3})%(?: \([^)]*\))?: (.*)$/

/** Parse a Tor notice line → bootstrap progress update, or null if unrelated. */
export function parseBootstrapLine(line: string): { progress: number; summary: string } | null {
  const m = BOOTSTRAP_RE.exec(line.trim())
  if (!m) return null
  const progress = Math.min(100, Math.max(0, parseInt(m[1], 10)))
  return { progress, summary: m[2].trim() }
}

/** True for Tor `[err]` lines (fatal config/bind failures). */
export function isTorErrorLine(line: string): boolean {
  return /\[err\]/.test(line)
}

/** The sio bridge only ever dials the relay's hidden service. */
export function isOnionUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'ws:') && u.hostname.endsWith('.onion')
  } catch {
    return false
  }
}
