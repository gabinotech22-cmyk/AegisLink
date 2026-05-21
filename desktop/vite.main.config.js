import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'electron/main.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron', 'keytar', 'better-sqlite3', 'path', 'fs', 'os'],
      output: { entryFileNames: '[name].js' },
    },
    outDir: '.vite/build',
    emptyOutDir: false,
  },
});
