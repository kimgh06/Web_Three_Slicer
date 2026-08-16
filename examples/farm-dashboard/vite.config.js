import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the same build works at a domain root and under a sub-path — the /demos route in
  // web/viewer serves these from /demos/<name>/.
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['three-slicer'] },

})
