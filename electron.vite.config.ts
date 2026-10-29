import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'node:fs'
import { rendererPackagePlugin } from './scripts/package-files.mjs'
import { embedStartupIcons } from './src/renderer/startupMarkup'

export default defineConfig({
  main: {
    // ws otherwise sees its optional native `bufferutil` shim as available after
    // bundling, then crashes on larger frames because the shim has no `mask`.
    // The built-in JavaScript masker is always present and correct.
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1')
    },
    build: {
      rollupOptions: {
        input: {
          assistantWorker: resolve(__dirname, 'src/main/assistant/worker.ts'),
          claudeSdkWorker: resolve(__dirname, 'src/main/claudeSdkWorker.ts'),
          index: resolve(__dirname, 'src/main/launch.ts'),
          sessionLogWriter: resolve(__dirname, 'src/main/sessionLogWriter.ts'),
          performanceWorker: resolve(__dirname, 'src/main/performanceWorker.ts'),
          nativeTokenUsageWorker: resolve(__dirname, 'src/main/nativeTokenUsageWorker.ts'),
          codexSourceRouter: resolve(__dirname, 'src/main/codexSourceRouter.ts')
        },
        output: { chunkFileNames: '[name]-[hash].js' },
        external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html'), boot: resolve(__dirname, 'src/renderer/boot.html'), detail: resolve(__dirname, 'src/renderer/detail.html') },
        // Preserve old hashed assets so an open App can still load diagrams after repacking.
      },
      emptyOutDir: false
    },
    plugins: [{
      name: 'startup-markup',
      transformIndexHtml: (html) => html
        .replace('<!-- uniagent-startup-style -->',
          `<style>${readFileSync(resolve(__dirname, 'src/renderer/startup.css'), 'utf8')}</style>`)
        .replace('<!-- uniagent-startup -->',
          embedStartupIcons(readFileSync(resolve(__dirname, 'src/renderer/startup.html'), 'utf8')))
    }, react(), rendererPackagePlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})
