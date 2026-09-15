/**
 * Minimal x.y.z comparison for the in-app version notice. Deliberately tiny:
 * we only ever compare our own marketing versions, which are always three
 * integers. Anything else parses as 0, so a garbage value from the relay
 * compares as "older than everything" and can never trigger an update gate.
 */

function parse(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** True when `installed` is strictly older than `target`. */
export function isOlderThan(installed: string, target: string): boolean {
  return compareVersions(installed, target) < 0;
}
