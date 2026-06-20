/**
 * Universal links — Android App Links plumbing for invite URLs.
 *
 * /.well-known/assetlinks.json  → lets Android verify com.aegislink.app as the
 *                                 default handler for this domain (autoVerify).
 * /g, /a                        → tiny dark landing pages for group invites and
 *                                 contact links opened OUTSIDE the app (or
 *                                 before App Links verification).
 *
 * ZERO-METADATA INVARIANT: the invite payload travels in the URL FRAGMENT
 * (https://…/g#v1/<groupId>/…). Browsers NEVER send fragments to the server,
 * so these handlers receive a bare "GET /g" — no group id, name, admin or
 * contact id ever reaches the relay (or nginx access logs). The landing page
 * reads location.hash CLIENT-SIDE and bounces to the aegislink:// scheme.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';

const router = Router();

// SHA-256 signing-cert fingerprints allowed to handle the domain links:
// release keystore (Play builds) + Android debug keystore (local/emulator
// builds, which currently sign release APKs too).
const CERT_FINGERPRINTS = [
  '4E:D3:A7:32:E8:A1:B2:03:08:60:C7:6D:D3:EE:8C:5D:E9:97:6A:49:95:2C:4D:E3:60:C6:9D:09:3E:CA:4E:D3',
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
];

const ASSETLINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.aegislink.app',
      sha256_cert_fingerprints: CERT_FINGERPRINTS,
    },
  },
];

router.get('/.well-known/assetlinks.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(ASSETLINKS);
});

/**
 * Inline bootstrap script for a landing page. Extracted so its EXACT bytes can
 * be SHA-256 hashed for the page's `script-src 'sha256-…'` CSP (M-4): the hash
 * must cover precisely what sits between <script> and </script>, so the same
 * string is both embedded and hashed — no whitespace drift. The only variable is
 * the constant `schemePrefix`; no user input is ever interpolated server-side.
 */
function landingScript(schemePrefix: string): string {
  return `(function(){var h=location.hash.slice(1);if(!h){document.getElementById('msg').textContent='Enlace incompleto.';return;}var u=${JSON.stringify(schemePrefix)}+h;var b=document.getElementById('open');b.href=u;b.style.display='inline-block';location.href=u;})();`;
}

/**
 * `kind` selects the aegislink:// prefix the fragment is appended to:
 *   /g → aegislink://group/<fragment>   (fragment = v1/<gid>/<name>/<admin>)
 *   /a → aegislink://<fragment>         (fragment = v1/<id>/<pubkey>)
 * No user input is interpolated server-side — the page is a constant.
 *
 * Returns the HTML plus the matching `Content-Security-Policy` (M-4). The CSP
 * pins the inline script by its SHA-256 hash (no 'unsafe-inline' for scripts —
 * any injected <script> is refused). Inline STYLES are allowed ('unsafe-inline'
 * for style only): they cannot execute code, and the page is a server-side
 * constant, so the residual risk is nil. Everything else is denied.
 */
function renderLanding(kind: 'group' | 'contact'): { html: string; csp: string } {
  const schemePrefix = kind === 'group' ? 'aegislink://group/' : 'aegislink://';
  const title = kind === 'group' ? 'Invitación a grupo' : 'Contacto AegisLink';
  const script = landingScript(schemePrefix);
  const scriptHash = createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>AegisLink — ${title}</title>
<style>
  body{background:#0b0f0e;color:#e7efec;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  main{text-align:center;padding:28px;max-width:420px}
  h1{font-size:22px;letter-spacing:-0.3px;margin:0 0 6px}
  p{color:#9fb3ac;font-size:14px;line-height:1.55;margin:10px 0}
  a.btn{display:inline-block;margin-top:16px;padding:13px 26px;border:1px solid #5bf2b9;border-radius:13px;color:#5bf2b9;text-decoration:none;font-weight:600}
  .mono{font-family:ui-monospace,monospace;font-size:11px;color:#5e7a71;letter-spacing:1px;margin-top:26px}
</style></head><body><main>
<h1>AegisLink</h1>
<p id="msg">Abriendo en la app…</p>
<a class="btn" id="open" href="#" style="display:none">Abrir en AegisLink</a>
<p>Si no tienes AegisLink instalada, instálala y vuelve a abrir este enlace.</p>
<p class="mono">E2EE · SIN METADATOS</p>
<script>${script}</script></main></body></html>`;
  return { html, csp };
}

router.get('/g', (_req, res) => {
  const { html, csp } = renderLanding('group');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Security-Policy', csp);
  res.type('html').send(html);
});

router.get('/a', (_req, res) => {
  const { html, csp } = renderLanding('contact');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Security-Policy', csp);
  res.type('html').send(html);
});

export default router;
