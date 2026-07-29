# Web Three Slicer

A 3D-printing slicer that runs entirely in the browser — reverse-engineered from [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) into a WASM kernel + npm packages. STL/OBJ/3MF/AMF/PLY in, G-code out; no server, no install.

## Packages (`web/`, npm workspaces)

| Package | What it is |
|---|---|
| `@three-slicer/engine` | WASM slicing kernel SDK — batch/streaming slice, worker protocol, settings mapping. Headless-capable (Node or browser), **no three.js dependency** |
| `@three-slicer/data` | Extracted OrcaSlicer metadata: config schema (907 options), UI tree, toggle rules, invalidation map |
| `@three-slicer/components` | React `<SettingsPanel/>` — schema-driven settings form, props-only |
| `@three-slicer/viewer` | React `<Viewport/>` — three.js scene, model import, worker slicing, GPU volumetric toolpath preview (libvgcode port) |

Quick taste:

```jsx
import { useState } from 'react'
import Viewport from '@three-slicer/viewer'
import SettingsPanel from '@three-slicer/components/SettingsPanel'
import '@three-slicer/viewer/styles.css'

function App() {
  const [settings, setSettings] = useState({})       // OrcaSlicer schema keys, sparse
  return (<>
    <Viewport settings={settings} setSettings={setSettings} />
    <SettingsPanel settings={settings} setSettings={setSettings} />
  </>)
}
```

Headless (no UI): `const s = await createSlicer(); s.slice(stl, params)` — see `web/packages/engine/README.md`.

## Repository layout

- **`web/`** — everything above + demo viewer app + WASM kernel C++ sources (`wasm-core/`). Self-contained: builds, tests, and runs without `slicer/`.
- **`slicer/`** — upstream OrcaSlicer, kept as an untracked reference clone (its own git remote). Used only as the extraction/porting source.

```bash
# demo viewer (committed WASM — no emscripten needed)
cd web/viewer && npm i && npm run dev

# kernel test suite (120+ invariants)
node web/wasm-core/test.mjs

# tarball independence gate (packs all 4, builds Vite+Next consumers outside the repo)
bash web/pack_check.sh
```

Korean development docs: [`web/README.md`](web/README.md), [`web/GUIDE.md`](web/GUIDE.md), [`web/SPECS.md`](web/SPECS.md).

## License

AGPL-3.0-or-later (see [`LICENSE.txt`](LICENSE.txt)) — derived from OrcaSlicer. Note that AGPL extends to network use: a web service embedding these packages must offer its source to its users.
