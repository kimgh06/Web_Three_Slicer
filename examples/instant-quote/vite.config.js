import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the same build works at a domain root and under a sub-path — the /demos route in
  // web/viewer serves these from /demos/<name>/.
  base: './',
  // The two three-slicer requirements: the kernel worker is an ES module, and the multithreaded
  // glue uses top-level await.
  worker: { format: 'es' },
  build: { target: 'es2022' },

  // The worker URL is built with `new URL('./src/slicer.worker.js', import.meta.url)` inside the
  // package, which esbuild's dep pre-bundling would rewrite away in dev.
  optimizeDeps: { exclude: ['three-slicer'] },

  // Cross-origin isolation switches the kernel to the multithreaded build and makes
  // `estimator.cancel()` able to stop a running slice instead of killing the worker. Left off so
  // that dev matches plain static hosting, which is how this demo is deployed.
  // server: {
  //   headers: {
  //     'Cross-Origin-Opener-Policy': 'same-origin',
  //     'Cross-Origin-Embedder-Policy': 'require-corp',
  //   },
  // },
})
