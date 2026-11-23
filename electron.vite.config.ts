import { defineConfig } from 'electron-vite'

// Builds only the engine: the main process and the preload bridge. The interface is not part of this repository.
export default defineConfig({
  main: { build: { outDir: 'out/main' } },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  }
})
