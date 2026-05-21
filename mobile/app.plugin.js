/**
 * AegisLink — Dynamic App Icons config plugin
 *
 * What it does:
 *   1. Copies pre-generated flat + adaptive foreground PNGs into Android res/
 *   2. Copies adaptive icon XML (mipmap-anydpi-v26) into Android res/
 *   3. Injects background colors into res/values/colors.xml
 *   4. Adds <activity-alias> entries to AndroidManifest.xml
 *
 * No image processing at build time → stable Gradle builds.
 * Icons are pre-generated locally via: node scripts/gen-icons.js
 */
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const VARIANTS = [
  { name: 'dark',   bg: '#06090a' },
  { name: 'light',  bg: '#efece4' },
  { name: 'tinted', bg: '#14161c' },
  { name: 'work',   bg: '#1c1f55' },
];

const FLAT_FOLDERS = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];

// ─── Step 1: Copy PNGs + XMLs into Android res/ ──────────────────────────────
function withCopyIcons(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      const src = path.join(projectRoot, 'android-icon-assets');

      for (const v of VARIANTS) {
        // Flat fallback PNGs
        for (const folder of FLAT_FOLDERS) {
          const srcFile = path.join(src, v.name, folder, `ic_launcher_${v.name}.png`);
          if (!fs.existsSync(srcFile)) continue;
          const destDir = path.join(resDir, folder);
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcFile, path.join(destDir, `ic_launcher_${v.name}.png`));

          // Adaptive foreground PNGs
          const fgFile = path.join(src, v.name, folder, `ic_launcher_${v.name}_fg.png`);
          if (fs.existsSync(fgFile)) {
            fs.copyFileSync(fgFile, path.join(destDir, `ic_launcher_${v.name}_fg.png`));
          }
        }

        // Adaptive icon XML (API 26+)
        const xmlSrc = path.join(src, v.name, 'mipmap-anydpi-v26', `ic_launcher_${v.name}.xml`);
        if (fs.existsSync(xmlSrc)) {
          const xmlDestDir = path.join(resDir, 'mipmap-anydpi-v26');
          fs.mkdirSync(xmlDestDir, { recursive: true });
          fs.copyFileSync(xmlSrc, path.join(xmlDestDir, `ic_launcher_${v.name}.xml`));
        }
      }

      // Inject background colors into res/values/colors.xml
      const colorsFile = path.join(resDir, 'values', 'colors.xml');
      let colorsContent = fs.existsSync(colorsFile)
        ? fs.readFileSync(colorsFile, 'utf8')
        : '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n';

      for (const v of VARIANTS) {
        const tag = `<color name="ic_launcher_${v.name}_bg">`;
        if (!colorsContent.includes(tag)) {
          colorsContent = colorsContent.replace(
            '</resources>',
            `    ${tag}${v.bg}</color>\n</resources>`
          );
        }
      }
      fs.mkdirSync(path.join(resDir, 'values'), { recursive: true });
      fs.writeFileSync(colorsFile, colorsContent);

      return config;
    },
  ]);
}

// ─── Step 2: Add <activity-alias> entries to AndroidManifest ─────────────────
function withIconAliases(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;

    const pkg = config.android?.package ?? 'com.aegislink.app';
    const mainActivity = `${pkg}.MainActivity`;

    // Remove stale aliases to avoid duplicates on rebuild
    app['activity-alias'] = (app['activity-alias'] ?? []).filter(
      (a) => !VARIANTS.some((v) => a.$?.['android:name']?.endsWith(`${v.name}Icon`))
    );

    for (const v of VARIANTS) {
      app['activity-alias'].push({
        $: {
          'android:name': `${mainActivity}${v.name}Icon`,
          'android:enabled': 'false',
          'android:exported': 'true',
          'android:icon': `@mipmap/ic_launcher_${v.name}`,
          'android:roundIcon': `@mipmap/ic_launcher_${v.name}`,
          'android:targetActivity': mainActivity,
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
            category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
          },
        ],
      });
    }

    return config;
  });
}

module.exports = (config) => {
  config = withCopyIcons(config);
  config = withIconAliases(config);
  return config;
};
