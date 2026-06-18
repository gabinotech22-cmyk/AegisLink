import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
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
})
