import type { CSSProperties } from 'react';

interface Props {
  /** Deterministic seed — typically the contact/identity's publicKeyB64 (preferred) or aegisId. */
  seed: string;
  size?: number;
  /** Fixed tint color. If omitted, a hue is derived from the seed's hash so untinted identicons still vary. */
  color?: string;
  /** When true, clips the grid into a circular mask matching the surrounding avatar. */
  rounded?: boolean;
}

const GRID = 5;

/** FNV-1a 32-bit hash — fast, deterministic, no external dependency. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Simple LCG PRNG seeded from the hash — deterministic sequence per seed. */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Renders a deterministic 5x5 symmetric identicon (columns 0-2 mirrored to
 * columns 3-4) as inline SVG rects. Same seed -> same drawing, always.
 * DOM/SVG port of mobile/src/components/Identicon.tsx — keep the hash + LCG in
 * lockstep so the same seed renders the same identicon on both platforms.
 */
export function Identicon({ seed, size = 44, color, rounded }: Props) {
  const h = hash(seed);
  const rnd = makeLcg(h);
  const cells: Array<{ col: number; row: number }> = [];
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < GRID; r++) {
      if (rnd() > 0.5) {
        cells.push({ col: c, row: r });
        const mirrored = GRID - 1 - c;
        if (mirrored !== c) cells.push({ col: mirrored, row: r });
      }
    }
  }

  const fill = color ?? `hsl(${h % 360}, 60%, 58%)`;
  const cellSize = size / GRID;

  const svg = (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {cells.map(({ col, row }, i) => (
        <rect
          key={i}
          x={col * cellSize}
          y={row * cellSize}
          width={cellSize}
          height={cellSize}
          fill={fill}
        />
      ))}
    </svg>
  );

  if (!rounded) return svg;

  const wrap: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    display: 'flex',
  };
  return <div style={wrap}>{svg}</div>;
}
