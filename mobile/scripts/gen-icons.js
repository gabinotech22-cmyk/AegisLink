/**
 * Pre-generates Android adaptive + fallback icons for each AegisLink variant.
 * Run once locally: node scripts/gen-icons.js
 *
 * Android adaptive icon safe zone:
 *   Full canvas = 108dp, safe zone = center 72dp → padding = 18/108 ≈ 16.67% each side
 *   We use 18% padding to be safe on all launchers (Samsung, Pixel, etc.)
 *
 * Outputs:
 *   android-icon-assets/{variant}/mipmap-{density}/ic_launcher_{variant}.png   ← flat fallback
 *   android-icon-assets/{variant}/mipmap-{density}/ic_launcher_{variant}_fg.png ← adaptive foreground
 *   android-icon-assets/{variant}/mipmap-anydpi-v26/ic_launcher_{variant}.xml  ← adaptive icon XML
 */
const { generateImageAsync } = require('@expo/image-utils');
const fs = require('fs');
const path = require('path');

const VARIANTS = [
  { name: 'dark',    src: './assets/icon-dark.png',    bg: '#06090a' },
  { name: 'light',   src: './assets/icon-light.png',   bg: '#efece4' },
  { name: 'tinted',  src: './assets/icon-tinted.png',  bg: '#14161c' },
  { name: 'work',    src: './assets/icon-work.png',    bg: '#1c1f55' },
];

// Standard Android launcher icon sizes (flat fallback)
const FLAT_DENSITIES = [
  { folder: 'mipmap-mdpi',    size: 48 },
  { folder: 'mipmap-hdpi',    size: 72 },
  { folder: 'mipmap-xhdpi',   size: 96 },
  { folder: 'mipmap-xxhdpi',  size: 144 },
  { folder: 'mipmap-xxxhdpi', size: 192 },
];

// Adaptive icon foreground sizes (108dp × density scale factor)
// foreground canvas = 108dp, artwork safe zone = 72dp (center 66.7%)
// We embed the icon artwork at 66% of the foreground canvas + transparent padding
const FG_DENSITIES = [
  { folder: 'mipmap-mdpi',    size: 108 },  // 1×
  { folder: 'mipmap-hdpi',    size: 162 },  // 1.5×
  { folder: 'mipmap-xhdpi',   size: 216 },  // 2×
  { folder: 'mipmap-xxhdpi',  size: 324 },  // 3×
  { folder: 'mipmap-xxxhdpi', size: 432 },  // 4×
];

const OUT_DIR = path.join(__dirname, '..', 'android-icon-assets');
const PROJECT_ROOT = path.join(__dirname, '..');

// Padding fraction: 18% on each side → artwork fills 64% of foreground canvas
const PADDING_FRACTION = 0.18;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const variant of VARIANTS) {
    console.log(`\n▶ Variant: ${variant.name}`);

    // 1. Flat fallback icons (with safe-zone padding baked in)
    //    We generate at a larger size then resize — padding is applied by sizing
    //    the artwork to fill only the center 64% of the final icon.
    console.log('  Flat fallback icons:');
    for (const d of FLAT_DENSITIES) {
      const outDir = path.join(OUT_DIR, variant.name, d.folder);
      fs.mkdirSync(outDir, { recursive: true });

      // Generate the icon sized for the inner safe area (64% of full size)
      const artworkSize = Math.round(d.size * (1 - PADDING_FRACTION * 2));
      const { source } = await generateImageAsync(
        { projectRoot: PROJECT_ROOT },
        {
          src: variant.src,
          width: artworkSize,
          height: artworkSize,
          resizeMode: 'contain',
          backgroundColor: variant.bg,
        }
      );

      // Pad to full icon size by generating again at full size with contain
      const { source: padded } = await generateImageAsync(
        { projectRoot: PROJECT_ROOT },
        {
          src: variant.src,
          width: d.size,
          height: d.size,
          resizeMode: 'contain',  // keeps artwork centered with padding on sides
          backgroundColor: variant.bg,
        }
      );

      const outFile = path.join(outDir, `ic_launcher_${variant.name}.png`);
      fs.writeFileSync(outFile, padded);
      console.log(`    ✓ ${d.folder}/ic_launcher_${variant.name}.png (${d.size}px, bg: ${variant.bg})`);
    }

    // 2. Adaptive foreground layer (transparent background, artwork centered)
    console.log('  Adaptive foreground layers:');
    for (const d of FG_DENSITIES) {
      const outDir = path.join(OUT_DIR, variant.name, d.folder);
      fs.mkdirSync(outDir, { recursive: true });

      // Artwork fills center 64% of the foreground canvas (safe zone)
      const { source } = await generateImageAsync(
        { projectRoot: PROJECT_ROOT },
        {
          src: variant.src,
          width: d.size,
          height: d.size,
          resizeMode: 'contain',        // transparent padding = safe zone
          backgroundColor: 'transparent',
        }
      );

      const outFile = path.join(outDir, `ic_launcher_${variant.name}_fg.png`);
      fs.writeFileSync(outFile, source);
      console.log(`    ✓ ${d.folder}/ic_launcher_${variant.name}_fg.png (${d.size}px)`);
    }

    // 3. Adaptive icon XML (Android 8+ / API 26+)
    const xmlDir = path.join(OUT_DIR, variant.name, 'mipmap-anydpi-v26');
    fs.mkdirSync(xmlDir, { recursive: true });
    const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_${variant.name}_bg"/>
    <foreground android:drawable="@mipmap/ic_launcher_${variant.name}_fg"/>
</adaptive-icon>
`;
    fs.writeFileSync(path.join(xmlDir, `ic_launcher_${variant.name}.xml`), xmlContent);
    console.log(`  ✓ mipmap-anydpi-v26/ic_launcher_${variant.name}.xml`);
  }

  // 4. colors.xml entries (to append / reference in the plugin)
  const colorsXml = VARIANTS.map(v =>
    `    <color name="ic_launcher_${v.name}_bg">${v.bg}</color>`
  ).join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'colors_patch.xml'), `<!-- Add these to res/values/colors.xml -->\n${colorsXml}\n`);
  console.log('\n✓ colors_patch.xml written');
  console.log('\n✅ Done. Commit android-icon-assets/ to repo.');
}

main().catch(e => { console.error(e); process.exit(1); });
