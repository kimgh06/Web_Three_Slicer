# three-slicer

Browser/WASM 3D-printing slicer, reverse-engineered from [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer).
Slices STL to G-code entirely in the browser (or Node) — no server.

- **Engine** — WASM kernel: Arachne variable-width walls, gyroid/honeycomb/crosshatch infill,
  tree/grid supports, support painting, raft/brim/skirt, ironing, arc fitting, multi-material,
  layer streaming (OOM-tolerant), multithreaded kernel auto-selected on cross-origin-isolated sites.
- **Viewer** — React `<Viewport/>`: model import (STL/OBJ/3MF/AMF/PLY), transform gizmos,
  multi-plate, GPU toolpath preview (libvgcode port). Shadow-DOM isolated — no CSS collisions.
- **Settings UI** — React `<SettingsPanel/>`: 907 options driven by the extracted OrcaSlicer
  config schema, with search, mode filters, and custom widget registry.

## Install

```bash
npm i three-slicer            # engine only (Node-safe)
npm i three-slicer react react-dom three   # + viewer/components
```

## Use

```js
// Headless slicing (Node or browser main thread)
import { createSlicer } from 'three-slicer'
const s = await createSlicer()
const { gcode, stats } = s.slice(stlArrayBuffer, params)

// React viewer + settings panel
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
// <Viewport settings={settings} setSettings={setSettings} />

// Extracted data
import schema from 'three-slicer/data/config-schema.json'
```

Vite consumers need `worker: { format: 'es' }` and `build: { target: 'es2022' }`.
Serve with COOP/COEP headers to enable the multithreaded kernel (~2.2× faster).

## License

AGPL-3.0-or-later — derived from OrcaSlicer.
Source: https://github.com/kimgh06/Web_Three_Slicer
