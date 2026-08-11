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
- Vendor printer, print-process and filament preset catalogs, with one material assignable per extruder.
- Support painting and material painting, plus per-tool filament and purge statistics.
- Extracted data files for custom UIs: config schema, UI tree, toggle rules, invalidation map, and the printer/process/filament catalogs.
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

Type declarations ship with the package — no `@types/*` needed. All 923 setting keys are typed from the config schema, enum values included:

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

`deriveKernelParams()` maps the curated set of schema keys currently supported by the kernel (92 today). Other schema keys can still be displayed by the UI, but they may not affect slicing output yet. Vector options are simplified to their first element, except the filament options described below, which keep every extruder's entry.

## Materials and Multi-Material

A material is a filament preset — temperatures, flow, diameter, cooling, and the retraction/z-hop overrides a material may apply on top of the machine's. Read the catalog through the facade rather than decoding the data file:

```js
import { filamentPresets } from 'three-slicer/settings'

const filaments = await filamentPresets()
filaments.listFor('Bambu Lab X1 Carbon 0.4 nozzle')          // [{name, type, vendor}, …]
filaments.recommendedFor('Bambu Lab X1 Carbon 0.4 nozzle')   // the vendor's shortlist for that machine model
const material = filaments.settingsFor('Bambu PLA Basic @BBL X1C')
```

The filament key set is disjoint from the process key set, so applying a material never clears a process pick and vice versa.

**One material per extruder.** OrcaSlicer stores every filament option as one entry per extruder, so a multi-material settings map writes each extruder's material at its own index:

```js
const params = {
  ...deriveKernelParams({
    nozzle_temperature: [255, 220],     // T0 ABS, T1 PLA
    filament_flow_ratio: [0.95, 1.0],
  }),
  extruder_count: 2,                    // set on the params directly; not a derived schema key
}
```

The kernel reloads the loaded-filament settings at every tool change and reports the split back as `stats.filament_mm_by_tool` (indexed by tool number, sums to `filament_mm`) plus `stats.filament_mm_purge` for the prime/wipe tower share. `support_filament` and `support_interface_filament` are 1-based filament indices — `0` means "keep the loaded tool" — choosing which extruder prints the support base/raft and the support interface.

A single-material slice sends none of these keys and produces exactly the G-code it produced before multi-material existed.

### Painting a region onto another extruder

Painting is the only way a single object can print in two materials. Painting states follow OrcaSlicer's own enum, in which state `1` is both the support enforcer and Extruder 1, state `2` is both the support blocker and Extruder 2, and `3..16` are Extruders 3 to 16. The state-addressed protocol is on the worker; `slicer.paint()` on the direct handle is the original enforcer/blocker boolean pair.

```js
worker.postMessage({ cmd: 'prepare', stl })
worker.postMessage({ cmd: 'paint', state: 3, facet, hx, hy, hz, cx, cy, cz, radius, states: [1, 2, 3] })
worker.postMessage({ cmd: 'erase', facet, hx, hy, hz, cx, cy, cz, radius })
```

`erase` is a separate command rather than `state: 0`, because a JS `false` coerces to `0` at the WASM boundary and the legacy blocker brush sends exactly that — so the state path refuses `0` outright.

Because a single enum serves both jobs, a support blocker paint and an Extruder 2 paint are the same mark on a facet, and painted materials only take effect with support turned off (the painted multi-material path emits no support). Support painting is unaffected: a support-enabled slice stays on the single-material path.

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
| `three-slicer/data/config-schema.json` | Setting definitions, defaults, labels, units, and option metadata (923 options) |
| `three-slicer/data/ui-tree.json` | Tab, page, group, and option layout |
| `three-slicer/data/toggle-rules.json` | Original enable/disable rule metadata |
| `three-slicer/data/invalidation-map.json` | Setting invalidation/dependency metadata |
| `three-slicer/data/printers.json` | 1,035 vendor machine profiles across 64 vendors: motion limits, bed, nozzle |
| `three-slicer/data/processes.js` | 2,243 print presets (speeds, accelerations) |
| `three-slicer/data/filaments.js` | 5,999 material presets over 81 filament types, plus each printer model's recommended list |

The last three are large, column-oriented and deduplicated, and they load on demand. Read them through
`printerSettings()`, `processPresets()` and `filamentPresets()` from `three-slicer/settings` rather than decoding
the layout by hand.

## API Reference

| API | Description |
| --- | --- |
| `createSlicer()` | Loads the WASM kernel and returns a slicer handle |
| `slicer.slice(stl, params, callbacks?)` | Slices binary STL input to G-code or streamed layers |
| `slicer.paintPrepare(stl)` | Prepares painting against a model |
| `slicer.paint(args)` | Paints enforcer/blocker data (boolean pair; the state-addressed form is worker-only) |
| `slicer.paintClear()` | Clears painting data for every state |
| `slicer.overlay(enforcer)` | Returns painting overlay data |
| `slicer.heapSize()` | Returns current WASM heap size |
| `slicer.dispose()` | Releases the slicer handle for garbage collection |
| `engineWorkerURL()` | Returns a browser worker URL |
| `deriveKernelParams(settings)` | Converts sparse OrcaSlicer settings to kernel params |
| `printerSettings(name)` | Settings a vendor machine profile applies |
| `processPresets()` | Lazy facade over the print (process) preset catalog |
| `filamentPresets()` | Lazy facade over the material preset catalog |
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
- Material painting and support cannot currently produce two materials on the same slice: the painted multi-material path emits no support, and one triangle selector serves both brushes.
- The multi-material prime tower is a real ported wipe tower, but the fallback square ring used when it fails is not.
- Multithreaded WASM requires cross-origin isolation.
- `three` is pinned as a peer dependency because viewer internals depend on the `TransformControls` API shape.

## License

AGPL-3.0-or-later. This package is derived from OrcaSlicer. Source is available at [kimgh06/Web_Three_Slicer](https://github.com/kimgh06/Web_Three_Slicer). If you embed it in a web app, make sure your app complies with the AGPL network-use requirements, including offering source code to users where required.
