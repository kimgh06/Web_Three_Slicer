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

## Bundler notes

- **Vite:** zero config. The slicing worker ships as a static `new Worker(new URL(...))` pattern — your bundler emits the worker chunk automatically.
- **Next.js / webpack:** render client-side (`dynamic(..., { ssr: false })`) and alias the emscripten glue's Node-only guards away:

```js
// next.config.js
module.exports = {
  webpack: (config) => {
    for (const m of ['node:module', 'node:fs', 'node:path', 'node:url', 'node:crypto'])
      config.resolve.alias[m] = false
    return config
  },
}
```

`three` is a peer dependency pinned to `^0.160` (TransformControls API; r169+ changed its Object3D contract).

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
