import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Workspace hoisting collapses react to a single copy in web/node_modules, so absolute-path aliases are unnecessary.
  //  Only dedupe is kept, which guarantees a single instance even if an app-local copy appears.
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  worker: { format: 'es' },   // needed for the worker's dynamic st/mt selection (code splitting) and the mt glue's top-level await
  build: { target: 'es2022' },   // top-level await in the mt glue (emscripten pthread) — Chrome 89+/Safari 15+

  // COOP/COEP -> crossOriginIsolated -> the worker picks the mt kernel automatically (-pthread, 2.2x). Without them it still runs on st.
  server: {
    // No fs.allow needed — Vite detects the workspaces in the root package.json and allows the whole repository by default
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  preview: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    // Allows the reverse-proxy domain. Add more hosts as a comma-separated ALLOWED_HOSTS in .env.
    allowedHosts: (process.env.ALLOWED_HOSTS || 'slicer.kimgh06.com').split(','),
  },
})
