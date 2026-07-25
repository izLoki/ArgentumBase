import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    open: true,
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
