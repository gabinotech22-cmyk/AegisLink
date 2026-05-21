/**
 * Generates assets/icon.ico and assets/icon.png from the AegisMark SVG.
 * Run once before `npm run make`.
 *
 * Usage:  node scripts/gen-icon.mjs
 * Needs:  npm install --save-dev @resvg/resvg-js  (pure-JS SVG rasterizer, no native deps)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS    = path.resolve(__dirname, '..', 'assets');

// ── AegisMark SVG (accent = #5bf2b9, transparent background) ─────────────────

const ACCENT = '#5bf2b9';

function makeIconSVG(size) {
  // viewBox 40×40 → scaled to `size`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none">
  <!-- background pill -->
  <rect width="40" height="40" rx="10" fill="#07090a"/>
  <!-- shield outline -->
  <path d="M20 3 L36 11 L36 29 L20 37 L4 29 L4 11 Z"
        stroke="${ACCENT}" stroke-width="2.4" stroke-linejoin="round"/>
  <!-- top bar -->
  <rect x="13" y="15" width="14" height="3.2" rx="0.4" fill="${ACCENT}"/>
  <!-- bottom bar (dimmed) -->
  <rect x="13" y="21.8" width="14" height="3.2" rx="0.4" fill="${ACCENT}" opacity="0.55"/>
</svg>`;
}

// ── Try to use @resvg/resvg-js if installed ──────────────────────────────────

async function tryResvg(sizes) {
  let Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch {
    return null;
  }

  const pngs = {};
  for (const s of sizes) {
    const svg = makeIconSVG(s);
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: s } });
    pngs[s] = resvg.render().asPng();
  }
  return pngs;
}

// ── Fallback: write SVG and instruct user ─────────────────────────────────────

function writeSVGFallback() {
  const svgPath = path.join(ASSETS, 'icon.svg');
  fs.writeFileSync(svgPath, makeIconSVG(256));
  console.log('\n✓ Wrote assets/icon.svg');
  console.log('\nTo convert to ICO, run ONE of:');
  console.log('  npx svgexport assets/icon.svg assets/icon.png 1024:1024');
  console.log('  # then use https://convertico.com to get icon.ico\n');
  console.log('OR install the rasterizer and re-run:');
  console.log('  npm install --save-dev @resvg/resvg-js && node scripts/gen-icon.mjs\n');
}

// ── ICO encoder (pure JS, no deps) ───────────────────────────────────────────
// Spec: https://en.wikipedia.org/wiki/ICO_(file_format)

function buildIco(pngBuffers) {
  // pngBuffers: array of { size, data: Buffer }
  const count  = pngBuffers.length;
  const dirSize = 6 + count * 16;
  let offset   = dirSize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0,     0); // reserved
  header.writeUInt16LE(1,     2); // type: ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const { size, data } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);  // width  (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1);  // height (0 = 256)
    entry.writeUInt8(0, 2);   // color count (0 = no palette)
    entry.writeUInt8(0, 3);   // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map(p => p.data)]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const SIZES = [16, 32, 48, 64, 128, 256];

const pngs = await tryResvg(SIZES);

if (!pngs) {
  writeSVGFallback();
  process.exit(0);
}

// Save 1024 png for macOS icns / general use
const png1024Path = path.join(ASSETS, 'icon.png');
// Use 256 as the "large" png since resvg was called with those sizes
fs.writeFileSync(png1024Path, pngs[256]);
console.log('✓ Wrote assets/icon.png  (256×256)');

// Build ICO with all sizes
const icoBuffers = SIZES.map(s => ({ size: s, data: Buffer.from(pngs[s]) }));
const ico = buildIco(icoBuffers);
const icoPath = path.join(ASSETS, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log(`✓ Wrote assets/icon.ico  (${SIZES.join(', ')} px)\n`);
console.log('Ready — run `npm run make` to build the installer.');
