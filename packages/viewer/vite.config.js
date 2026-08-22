import { defineConfig } from 'vite'

// Library build — transpiles JSX only; everything else stays external.
// The new URL pattern in slicer.worker.js must be preserved verbatim in dist (so consumer bundlers see a worker chunk).
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),   // pins entry/outDir even when run from the repo root cwd via --config
  build: {
    lib: {
      // 'parse_3mf.worker' is an entry rather than a bundled import: make_worker.js reaches it by relative URL from
      // dist/, and only dist/ is published. Keeping it an entry is what puts a file at that URL.
      entry: { Viewport: 'src/Viewport.jsx', toolpath_gpu: 'src/scene/toolpath_gpu.js', model_loaders: 'src/scene/model_loaders.js', gcode_parse: 'src/core/gcode_parse.js', 'parse_3mf.worker': 'src/parse_3mf.worker.js', 'sla_reconstruct.worker': 'src/sla_reconstruct.worker.js', 'sla_slice.worker': 'src/sla_slice.worker.js', 'sl1_encode.worker': 'src/sl1_encode.worker.js' },
      formats: ['es'],
    },
    outDir: 'dist',
    rollupOptions: {
      // make_worker.js is external + copied verbatim (build script) — preserves the static worker pattern for consumer bundlers.
      external: [/^react(-dom)?($|\/)/, /^three($|\/)/, /^three-slicer($|\/)/, /make_worker\.js$/],
      output: { paths: (id) => /make_worker\.js$/.test(id) ? './make_worker.js' : id },
    },
  },
})
