import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'out/workers',
    emptyOutDir: true,
    minify: false,
    ssr: true,
    lib: {
      entry: resolve('src/workers/nesting.worker.ts'),
      formats: ['es'],
      fileName: () => 'nesting.worker.mjs'
    },
    rollupOptions: {
      external: [
        'electron',
        'node:worker_threads',
        'node:fs',
        'node:path',
        'node:url',
        'node:crypto'
      ],
      output: {
        format: 'es',
        entryFileNames: 'nesting.worker.mjs'
      }
    }
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  }
})
