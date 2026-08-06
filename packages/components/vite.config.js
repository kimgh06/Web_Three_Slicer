import { defineConfig } from 'vite'

// Library build: raw JSX cannot be published (consumer bundlers do not transform JSX inside node_modules) -> transpile to ESM.
// react and @three-slicer/* are all external — dist contains only this component code.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),   // pins entry/outDir even when run from the repo root cwd via --config
  build: {
    lib: { entry: { SettingsPanel: 'SettingsPanel.jsx' }, formats: ['es'] },
    outDir: 'dist',
    rollupOptions: { external: [/^react(-dom)?($|\/)/, /^three-slicer($|\/)/] },
  },
})
