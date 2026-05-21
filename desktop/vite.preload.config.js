import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'electron/preload.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: '[name].js' },
    },
    outDir: '.vite/build',
    emptyOutDir: false,
  },
});
