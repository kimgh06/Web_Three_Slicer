# three-slicer

Browser/WASM 3D-printing slicer package derived from [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer). It can slice binary STL files to G-code in Node or the browser, and it also ships React UI pieces for building a browser slicer: a three.js viewport, GPU toolpath preview, and a schema-driven settings panel.

The package is published as a single npm package, `three-slicer`, with subpath exports for the engine, viewer, components, worker, and extracted OrcaSlicer data.

## Links

- Package: [npmjs.com/package/three-slicer](https://www.npmjs.com/package/three-slicer)
- Source: [kimgh06/Web_Three_Slicer](https://github.com/kimgh06/Web_Three_Slicer)
- Demo: [slicer.kimgh06.com](https://slicer.kimgh06.com/)

## Features

- WASM slicing engine with Arachne walls, infill patterns, supports, raft/brim/skirt, ironing, arc fitting, multi-material paths, and layer streaming.
- Headless SDK for Node or browser use with no `three.js` dependency.
- Browser worker entry for off-main-thread slicing.
- React `<Viewport/>` for model import, plate layout, transform controls, slicing, G-code export, and GPU toolpath preview.
- React `<SettingsPanel/>` generated from extracted OrcaSlicer metadata.
- Extracted data files for custom UIs: config schema, UI tree, toggle rules, and invalidation map.
- Automatic multithreaded WASM selection on cross-origin-isolated browser pages.

## Installation

```bash
npm i three-slicer
```

`react`, `react-dom`, and `three` are peer dependencies and npm installs them for you. They stay peers rather than dependencies because React and three must be single instances — a duplicate copy breaks hooks and `instanceof`.

Only the viewer and components import them. If you use the headless engine, they are installed into `node_modules` but never enter your bundle:

| Import path | Needs react/three at runtime |
| --- | --- |
| `three-slicer`, `/settings`, `/toggle`, `/worker`, `/wasm`, `/data` | no |
| `three-slicer/viewer`, `/viewer/toolpath`, `/viewer/loaders` | yes |
| `three-slicer/components` | react only |

## Quick Start: Headless Slicing

Use the root import when you only need STL-to-G-code slicing.

```js
import { createSlicer } from 'three-slicer'

const slicer = await createSlicer()

const result = slicer.slice(stlArrayBuffer, {
  layer_height: 0.2,
  first_layer_height: 0.2,
  line_width: 0.42,
  wall_loops: 2,
  infill_density: 0.15,
  nozzle_diameter: 0.4,
  filament_diameter: 1.75,
})

console.log(result.stats.layers)
console.log(result.gcode)

slicer.dispose()
```

`slice()` accepts a binary STL as an `ArrayBuffer` or `Uint8Array`. Parameters can be either a kernel params object or a JSON string.

## Streaming Layers

For large models, pass callbacks to receive each sliced layer as it is produced. This avoids keeping the full G-code and layer payload in memory at once.

```js
const chunks = []

const result = slicer.slice(stlArrayBuffer, params, {
  onProgress(done, total) {
    console.log(`${done}/${total}`)
  },
  onLayer(layer) {
    chunks.push(layer.gcode)
  },
})

const gcode = chunks.join('')
console.log(result.stats)
```

When `onLayer` is set, the returned result carries stats; assemble G-code from the layer callback if you need the full file.

## Quick Start: React Viewer

Use `three-slicer/viewer` when you want a ready-made browser slicer viewport.

```jsx
import { useState } from 'react'
import Viewport from 'three-slicer/viewer'

export default function App() {
  const [settings, setSettings] = useState({})

  return (
    <Viewport
      settings={settings}
      setSettings={setSettings}
    />
  )
}
```

The viewer handles model loading, drag and drop, transform controls, multi-plate layout, worker slicing, GPU toolpath preview, and G-code export. It supports STL, OBJ, 3MF (including the production extension used by Orca/Bambu/Prusa), AMF, and PLY out of the box; other formats such as STEP can be added with `registerLoader()`. Viewer and component styles are bundled into their Shadow DOM roots, so host app CSS does not need to import package CSS.

## Quick Start: Settings Panel

Use `three-slicer/components` when you want the OrcaSlicer-style settings UI without building the form yourself.

```jsx
import { useState } from 'react'
import SettingsPanel from 'three-slicer/components'

export default function App() {
  const [settings, setSettings] = useState({})

  return (
    <SettingsPanel
      settings={settings}
      setSettings={setSettings}
    />
  )
}
```

`settings` is a sparse object keyed by OrcaSlicer setting names. Store only edited values; missing keys fall back to schema defaults.

## Full React Example

The viewer and settings panel are designed to share the same `settings` state.

```jsx
import { useState } from 'react'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'

export default function App() {
  const [settings, setSettings] = useState({})

  return (
    <main style={{ display: 'flex', height: '100vh' }}>
      <Viewport
        settings={settings}
        setSettings={setSettings}
      />
      <SettingsPanel
        settings={settings}
        setSettings={setSettings}
      />
    </main>
  )
}
```

The same sparse settings map can feed the settings panel, the viewer, and `deriveKernelParams()`.

## Import Paths

```js
import { createSlicer, engineWorkerURL } from 'three-slicer'
import { deriveKernelParams } from 'three-slicer/settings'
import { disabledKeys, makeCfg } from 'three-slicer/toggle'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
import { schema, uiTree } from 'three-slicer/data'
```

Available subpaths:

| Import path | Use |
| --- | --- |
| `three-slicer` | Headless WASM engine SDK |
| `three-slicer/settings` | Schema defaults and settings-to-kernel mapping |
| `three-slicer/toggle` | Enable/disable rule evaluation for settings UIs |
| `three-slicer/worker` | Browser worker entry |
| `three-slicer/wasm` | Single-threaded Emscripten WASM glue |
| `three-slicer/wasm-mt` | Multithreaded Emscripten WASM glue |
| `three-slicer/viewer` | React `<Viewport/>` |
| `three-slicer/viewer/toolpath` | GPU toolpath renderer utilities |
| `three-slicer/viewer/loaders` | Model loaders |
| `three-slicer/components` | React `<SettingsPanel/>` |
| `three-slicer/data` | Named exports for extracted metadata |
| `three-slicer/data/*.json` | Extracted OrcaSlicer metadata |

## TypeScript

Type declarations ship with the package — no `@types/*` needed. All 907 setting keys are typed from the config schema, enum values included:

```ts
import { createSlicer, type SlicerSettings } from 'three-slicer'
import { deriveKernelParams } from 'three-slicer/settings'

const settings: SlicerSettings = {
  layer_height: 0.2,
  sparse_infill_pattern: 'gyroid',   // autocompletes; 'nope' is a type error
}

const slicer = await createSlicer()
slicer.slice(stlArrayBuffer, deriveKernelParams(settings))
```

Requires `"moduleResolution": "bundler"`, `"node16"`, or `"nodenext"`. The declarations are wired through the `exports` field, which the legacy `"node"` resolution ignores.

## Settings Model

There are two related settings shapes:

| Shape | Used by | Description |
| --- | --- | --- |
| Sparse OrcaSlicer settings map | `<SettingsPanel/>`, `<Viewport/>` | Object keyed by original OrcaSlicer schema keys. Missing keys use schema defaults. |
| Kernel params | `slicer.slice()` | Flat object consumed directly by the WASM kernel. |

To convert UI settings to kernel params:

```js
import { deriveKernelParams } from 'three-slicer/settings'

const settings = {
  layer_height: 0.25,
  sparse_infill_density: 15,
  wall_loops: 3,
}

const params = deriveKernelParams(settings)
const result = slicer.slice(stlArrayBuffer, params)
```

`deriveKernelParams()` maps the curated set of schema keys currently supported by the kernel. Other schema keys can still be displayed by the UI, but they may not affect slicing output yet. Vector options are simplified to their first element.

## Worker Usage

Use a module worker to run slicing off the browser main thread.

```js
import { engineWorkerURL } from 'three-slicer'

const worker = new Worker(engineWorkerURL(), { type: 'module' })

worker.onmessage = (event) => {
  const message = event.data

  if (message.type === 'progress') {
    console.log(message.done, message.total)
  }

  if (message.type === 'layer') {
    console.log(message.idx, message.z, message.gcode)
  }

  if (message.type === 'done') {
    console.log(message.stats)
  }

  if (message.type === 'error') {
    console.error(message.error)
  }
}
```

The worker protocol emits `progress`, `layer`, `done`, and `error` messages. For bundler-specific setups, `three-slicer/worker` exposes the worker entry directly.

## Bundler Notes

Vite consumers should enable ES module workers and an ES2022 build target:

```js
import { defineConfig } from 'vite'

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
```

For Next.js or webpack apps, render the viewer on the client side and disable Node-only module aliases used by Emscripten guards.

```js
module.exports = {
  webpack: (config) => {
    for (const moduleName of [
      'node:module',
      'node:fs',
      'node:path',
      'node:url',
      'node:crypto',
      'node:worker_threads',
    ]) {
      config.resolve.alias[moduleName] = false
    }
    return config
  },
}
```

## Multithreaded WASM

The engine ships single-threaded and multithreaded WASM builds. The browser worker automatically uses the multithreaded kernel when the page is cross-origin isolated.

Serve these headers to enable it:

```txt
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without those headers, the engine falls back to the single-threaded kernel.

## Data Files

The package includes extracted OrcaSlicer metadata for custom interfaces:

| File | Use |
| --- | --- |
| `three-slicer/data/config-schema.json` | Setting definitions, defaults, labels, units, and option metadata |
| `three-slicer/data/ui-tree.json` | Tab, page, group, and option layout |
| `three-slicer/data/toggle-rules.json` | Original enable/disable rule metadata |
| `three-slicer/data/invalidation-map.json` | Setting invalidation/dependency metadata |

## API Reference

| API | Description |
| --- | --- |
| `createSlicer()` | Loads the WASM kernel and returns a slicer handle |
| `slicer.slice(stl, params, callbacks?)` | Slices binary STL input to G-code or streamed layers |
| `slicer.paintPrepare(stl)` | Prepares support painting against a model |
| `slicer.paint(args)` | Paints support enforcer/blocker data |
| `slicer.paintClear()` | Clears support painting data |
| `slicer.overlay(enforcer)` | Returns support painting overlay data |
| `slicer.heapSize()` | Returns current WASM heap size |
| `slicer.dispose()` | Releases the slicer handle for garbage collection |
| `engineWorkerURL()` | Returns a browser worker URL |
| `deriveKernelParams(settings)` | Converts sparse OrcaSlicer settings to kernel params |
| `<Viewport/>` | React slicer viewport |
| `<SettingsPanel/>` | React settings form |

## Runtime Support

| Environment | Supported use |
| --- | --- |
| Node ESM | Headless slicing |
| Browser main thread | Headless slicing |
| Browser worker | Off-main-thread slicing and streaming |
| React | Viewer and settings panel |
| three.js | Required by `three-slicer/viewer` |

## Known Limits

- `slice()` currently takes binary STL input at the engine API boundary.
- The viewer can import STL, OBJ, 3MF, AMF, and PLY, then converts them for slicing.
- `registerLoader(exts, fn)` from `three-slicer/viewer/loaders` adds any other format. Formats needing a heavy dependency are kept out of the package so it stays runtime-dependency-free — see `web/viewer/src/step_loader.js` for a STEP loader built on `occt-import-js` (OCCT WASM).
- Not every OrcaSlicer schema key is wired into the WASM kernel yet.
- Some vector settings are simplified to their first element.
- Multithreaded WASM requires cross-origin isolation.
- `three` is pinned as a peer dependency because viewer internals depend on the `TransformControls` API shape.

## License

AGPL-3.0-or-later. This package is derived from OrcaSlicer. Source is available at [kimgh06/Web_Three_Slicer](https://github.com/kimgh06/Web_Three_Slicer). If you embed it in a web app, make sure your app complies with the AGPL network-use requirements, including offering source code to users where required.
