import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const sharedAlias = {
  '@shared': resolve('src/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        },
        output: {
          format: 'es'
        }
      }
    },
    resolve: {
      alias: sharedAlias
    }
  },
  preload: {
    // bundle Effect because sandboxed preloads cannot resolve app dependencies at runtime
    plugins: [externalizeDepsPlugin({ exclude: ['effect'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        },
        output: {
          format: 'cjs'
        }
      }
    },
    resolve: {
      alias: sharedAlias
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    },
    resolve: {
      alias: sharedAlias
    },
    plugins: [vue()]
  }
})
