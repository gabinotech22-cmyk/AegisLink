// Capture the App Store / Play Store screenshots from the prototype, per locale.
//
// Screenshots are a PER-LOCALE store asset: both App Store Connect and Play Console
// attach a different set to each listing language, and the set on the primary
// language is what users in every country without their own listing see. The copy
// lives in prototype/store-shots.jsx (en/es/it) — see docs/APP-STORE-LISTING.md
// and docs/PLAY-STORE-LISTING.md.
//
// Usage (the prototype server must be running — .claude/launch.json → "prototype"):
//   npx --yes serve -l 4180 prototype
//   node scripts/capture-store-shots.mjs                    # both stores, all locales
//   node scripts/capture-store-shots.mjs --store play       # Play only
//   node scripts/capture-store-shots.mjs --lang it          # Italian only
//
// Not part of any product build. Idempotent: re-running just overwrites the PNGs.

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SHOTS = ['onboarding', 'home', 'chat', 'verify', 'call', 'groups', 'panic', 'devices'];
const LANGS = ['en', 'es', 'it'];

const STORES = {
  // App Store Connect: iPhone 6.5"/6.7" portrait. Play Console: classic safe phone size.
  app:  { page: 'appstore-shots',  width: 1284, height: 2778, outDir: 'promo-video/app-store/screenshots' },
  play: { page: 'playstore-shots', width: 1080, height: 1920, outDir: 'promo-video/play-store/screenshots' },
};

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const store = get('--store') || 'both';
  const langs = (get('--lang') || LANGS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const port = Number(get('--port') || 4180);

  const stores = store === 'both' ? Object.keys(STORES) : [store];
  for (const s of stores) {
    if (!STORES[s]) throw new Error(`unknown --store "${s}" (expected: app, play, both)`);
  }
  for (const l of langs) {
    if (!LANGS.includes(l)) throw new Error(`unknown --lang "${l}" (expected: ${LANGS.join(', ')})`);
  }
  return { stores, langs, port };
}

// Playwright is a dev-only dependency and this repo has no root package.json, so
// resolve it from wherever it happens to be installed instead of hard-failing.
async function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright', path.join(REPO_ROOT, '_scratch/node_modules/playwright')];
  for (const candidate of candidates) {
    try {
      // playwright is CommonJS — require() it directly so the named exports survive.
      return require(candidate).chromium;
    } catch { /* try the next one */ }
  }
  throw new Error(
    'playwright not found. Install it first, e.g.:\n' +
    '  npm i --no-save playwright && npx playwright install chromium'
  );
}

const { stores, langs, port } = parseArgs(process.argv.slice(2));
const chromium = await loadChromium();
const browser = await chromium.launch();

try {
  for (const storeId of stores) {
    const store = STORES[storeId];
    for (const lang of langs) {
      const outDir = path.join(REPO_ROOT, store.outDir, lang);
      await mkdir(outDir, { recursive: true });

      const page = await browser.newPage({
        viewport: { width: store.width, height: store.height },
        deviceScaleFactor: 1,
      });

      for (const [i, shot] of SHOTS.entries()) {
        const url = `http://localhost:${port}/${store.page}?shot=${shot}&lang=${lang}`;
        // React/Babel come from unpkg, so a slow CDN can stall networkidle — retry once.
        for (let attempt = 1; ; attempt++) {
          try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
            // Babel compiles the JSX in-page after load; wait for the canvas to exist.
            await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0,
                                       null, { timeout: 20_000 });
            break;
          } catch (err) {
            if (attempt >= 3) throw err;
            console.warn(`retrying ${shot} (${lang}): ${err.name}`);
          }
        }
        await page.waitForTimeout(400);

        const name = `${String(i + 1).padStart(2, '0')}-${shot}.png`;
        await page.screenshot({ path: path.join(outDir, name) });
        console.log(`${storeId}/${lang}/${name}`);
      }

      await page.close();
    }
  }
} finally {
  await browser.close();
}
