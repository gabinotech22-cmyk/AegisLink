/**
 * AegisLink — Expo config plugin bundle
 *
 * What it does:
 *   1. Copies pre-generated flat + adaptive foreground PNGs into Android res/
 *   2. Copies adaptive icon XML (mipmap-anydpi-v26) into Android res/
 *   3. Injects background colors into res/values/colors.xml
 *   4. Adds <activity-alias> entries to AndroidManifest.xml
 *   5. Writes network_security_config.xml with SHA-256 SPKI cert pins
 *      and wires android:networkSecurityConfig in AndroidManifest.xml
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

// ─── Step 3: Android network_security_config.xml with SPKI cert pinning ──────
//
// SHA-256 SPKI pins extracted from the live relay on 2026-05-27:
//   Primary: leaf cert  CN=aegislink.duckdns.org (Let's Encrypt E8, expires 2026-08-24)
//   Backup:  Let's Encrypt E8 intermediate (issuer=ISRG Root X1) — survives leaf rotation
//
// To refresh the primary pin after cert renewal:
//   echo Q | openssl s_client -connect 51.20.60.155:443 2>/dev/null \
//     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
//     | openssl dgst -sha256 -binary | openssl enc -base64
const SPKI_PRIMARY = 'CMcP8NMKUoqDBl0haU7v7dgEsxIFbWry8NjhhHzgX3c=';
const SPKI_BACKUP  = 'iFvwVyJSxnQdyaUvUERIf+8qk7gRze3612JMwoO3zdU='; // LE E8 intermediate

const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  Network Security Config — AegisLink
  Auto-generated by app.plugin.js during expo prebuild. Do not edit manually.

  Enforces SHA-256 SPKI pinning of the relay's TLS certificate to defeat MITM
  via compromised CAs or user-installed roots.

  ROTATION: when the relay's keypair rotates update SPKI_PRIMARY in app.plugin.js,
  rebuild, and release. The backup pin (LE E8 intermediate) survives leaf rotation.

  EXPIRATION: extend the expiration date before it passes — past expiration the
  pin-set is ignored (fail-open). 24 months is the recommended window.

  DEBUG: the <debug-overrides> block applies ONLY when the app is built with
  debuggable="true" so production releases NEVER trust user-installed roots.
-->
<network-security-config>
  <domain-config>
    <domain includeSubdomains="true">aegislink.duckdns.org</domain>
    <pin-set expiration="2027-12-31">
      <!-- PRIMARY: SHA-256 SPKI of leaf cert (CN=aegislink.duckdns.org, Let's Encrypt E8)
           Valid until: 2026-08-24 — renew cert + update SPKI_PRIMARY in app.plugin.js before expiry -->
      <pin digest="SHA-256">${SPKI_PRIMARY}</pin>
      <!-- BACKUP: SHA-256 SPKI of Let's Encrypt E8 intermediate (issuer=ISRG Root X1)
           Survives leaf-cert rotation as long as LE E8 signs the new cert. -->
      <pin digest="SHA-256">${SPKI_BACKUP}</pin>
    </pin-set>
  </domain-config>
  <debug-overrides>
    <trust-anchors>
      <certificates src="user"/>
      <certificates src="system"/>
    </trust-anchors>
  </debug-overrides>
</network-security-config>
`;

function withNetworkSecurity(config) {
  // Write network_security_config.xml via dangerous mod (file generation)
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      const xmlDir = path.join(resDir, 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), NETWORK_SECURITY_XML);
      return config;
    },
  ]);
  // Wire android:networkSecurityConfig + harden the <application> flags.
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (app?.$) {
      app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
      // Disable adb/cloud backup of the app's private dir — the SQLite
      // social-graph DB must never be exfiltrable via `adb backup`. Identity
      // keys live in the Keystore (excluded from backup regardless).
      app.$['android:allowBackup'] = 'false';
    }
    return config;
  });
  return config;
}

module.exports = (config) => {
  config = withCopyIcons(config);
  config = withIconAliases(config);
  config = withNetworkSecurity(config);
  return config;
};
