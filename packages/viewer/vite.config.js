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
      entry: { Viewport: 'src/Viewport.jsx', toolpath_reexport: 'src/toolpath_reexport.js', gcode_reexport: 'src/gcode_reexport.js', loaders_reexport: 'src/loaders_reexport.js' },
      formats: ['es'],
    },
    outDir: 'dist',
    rollupOptions: {
      external: [/^react(-dom)?($|\/)/, /^three($|\/)/, /^three-slicer($|\/)/,
        // The permissive package is a runtime DEPENDENCY, not something to bundle in: inlining it would
        //  put MIT-licensed code inside the AGPL tarball and defeat the split. Its own regex because
        //  /^three-slicer($|\/)/ does not match a name that continues with a hyphen.
        /^three-slicer-viewer($|\/)/],
    },
  },
})
