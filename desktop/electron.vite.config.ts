import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * CSP `connect-src` for the relay: the clearnet URL plus (when configured) the
 * Tor hidden service — http(s) origin and its ws(s) twin. Computed at build time
 * from the same VITE_ vars the renderer reads, so the meta CSP in index.html and
 * the header CSP in main/index.ts always agree. Nothing else is ever allowed.
 */
function relayConnectSrc(mode: string): string {
  const env = loadEnv(mode, process.cwd())
  const urls = [env['VITE_RELAY_URL'] ?? 'http://localhost:3001', env['VITE_ONION_URL']].filter(Boolean) as string[]
  const origins = urls.map((u) => { try { return new URL(u).origin } catch { return '' } }).filter(Boolean)
  return origins.flatMap((o) => [o, o.replace(/^http/, 'ws')]).join(' ')
}

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [
      react(),
      {
        name: 'relay-csp',
        transformIndexHtml(html) {
          return html.replace('__RELAY_CONNECT_SRC__', relayConnectSrc(mode))
        }
      },
      {
        // Vite dev injects an inline react-refresh preamble that the strict
        // CSP meta tag would block (blank window). Relax script-src in dev
        // only — `apply: 'serve'` never runs at build time.
        name: 'dev-csp-relax',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        }
      }
    ]
  }
}))
