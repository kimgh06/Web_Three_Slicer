// Two entries, matching the two published subpaths. No externals beyond three, and three is only a PEER —
// makeToolpath takes the THREE namespace as an argument rather than importing it, so a consumer that only
// parses G-code never pulls in a renderer at all.
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: { toolpath: 'src/scene/toolpath_gpu.js', gcode_parse: 'src/core/gcode_parse.js' },
      formats: ['es'],
    },
    rollupOptions: { external: ['three'] },
    target: 'es2022',
    emptyOutDir: true,
  },
})
