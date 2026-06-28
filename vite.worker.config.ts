import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'out/main/workers',
    emptyOutDir: false,
    minify: false,
    ssr: true,
    lib: {
      entry: resolve('src/workers/nesting.worker.ts'),
      formats: ['cjs'],
      fileName: () => 'nesting.worker.cjs'
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
        format: 'cjs',
        entryFileNames: 'nesting.worker.cjs'
      }
    }
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  }
})
