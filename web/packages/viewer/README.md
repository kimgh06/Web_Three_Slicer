# @three-slicer/viewer

3D slicer viewer as a React component: three.js viewport (orbit/transform gizmos), model import (STL/OBJ/3MF/AMF/PLY, multi-object, drag & drop), Web Worker slicing via `@three-slicer/engine`, support painting, multi-plate, and a GPU-instanced volumetric toolpath preview ported from OrcaSlicer's libvgcode (millions of segments in a single draw path, per-feature colors, layer range slider, G-code export).

```bash
npm i @three-slicer/viewer react react-dom three@^0.160.0
```

```jsx
import { useState } from 'react'
import Viewport from '@three-slicer/viewer'
import '@three-slicer/viewer/styles.css'

function App() {
  const [settings, setSettings] = useState({})   // OrcaSlicer schema keys; sparse — defaults fill the rest
  return <Viewport settings={settings} setSettings={setSettings} />
}
```

Slice parameters are derived from `settings` via `@three-slicer/engine`'s schema mapping — pair it with `@three-slicer/components`' `<SettingsPanel/>` sharing the same state for a full slicer UI.

Props: `settings`, `setSettings`, `processPanel` (optional React node rendered in the right sidebar).

Subpath exports for custom UIs (framework-free, no React):
- `@three-slicer/viewer/toolpath` — GPU toolpath renderer (`buildSegmentData`, `makeToolpath`, view-type colorers)
- `@three-slicer/viewer/loaders` — model loaders returning unified triangle soup

## Multithreaded slicing (automatic)

The engine ships two WASM kernels: single-threaded (default) and `-pthread` multithreaded (~2× wall-clock on layer-parallel wall generation, measured 12× on the wall pass itself). The worker picks the mt kernel automatically when the page is [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) — i.e. served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

No headers → falls back to the single-threaded kernel. Nothing else to change.

## Bundler notes

- **Vite:** two config lines (worker code-splitting + top-level await in the mt glue; Chrome 89+/Safari 15+):

```js
// vite.config.js
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
```

- **Next.js / webpack:** render client-side (`dynamic(..., { ssr: false })`) and alias the emscripten glue's Node-only guards away:

```js
// next.config.js
module.exports = {
  webpack: (config) => {
    for (const m of ['node:module', 'node:fs', 'node:path', 'node:url', 'node:crypto', 'node:worker_threads'])
      config.resolve.alias[m] = false
    return config
  },
}
```

`three` is a peer dependency pinned to `^0.160` (TransformControls API; r169+ changed its Object3D contract).

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
