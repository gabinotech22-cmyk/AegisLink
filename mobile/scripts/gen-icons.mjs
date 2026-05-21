/**
 * Generates PNG app icon assets from SVG sources.
 * Run: node scripts/gen-icons.mjs
 *
 * Requires: npm install -D @resvg/resvg-js
 */

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const iconsDir = join(root, 'assets', 'icons');
const assetsDir = join(root, 'assets');

const VARIANTS = ['dark', 'light', 'tinted', 'work'];

// Sizes needed for each variant (main icon: 1024, app store source)
const MAIN_SIZE = 1024;

function renderSvgToPng(svgPath, size) {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

console.log('Generating app icon PNGs...\n');

for (const variant of VARIANTS) {
  const svgPath = join(iconsDir, `icon-${variant}.svg`);
  const outPath = join(assetsDir, `icon-${variant}.png`);
  try {
    const png = renderSvgToPng(svgPath, MAIN_SIZE);
    writeFileSync(outPath, png);
    console.log(`✓  icon-${variant}.png  (${MAIN_SIZE}x${MAIN_SIZE})`);
  } catch (e) {
    console.error(`✗  icon-${variant}.png — ${e.message}`);
  }
}

// Also generate the adaptive icon foreground (transparent bg, mark only)
const adaptiveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100">
  <path d="M50 6 L86 25 L86 75 L50 94 L14 75 L14 25 Z"
        stroke="#5bf2b9" stroke-width="5.5" fill="none" stroke-linejoin="round"/>
  <rect x="32" y="38" width="36" height="8" rx="1" fill="#5bf2b9"/>
  <rect x="32" y="54" width="36" height="8" rx="1" fill="#5bf2b9" opacity="0.55"/>
</svg>`;

try {
  const resvg = new Resvg(adaptiveSvg, { fitTo: { mode: 'width', value: 1024 } });
  const png = resvg.render().asPng();
  writeFileSync(join(assetsDir, 'adaptive-icon.png'), png);
  console.log('✓  adaptive-icon.png  (1024x1024, transparent bg)');
} catch (e) {
  console.error(`✗  adaptive-icon.png — ${e.message}`);
}

console.log('\nDone. Run `eas build` to pick up the new icons.');
