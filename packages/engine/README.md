# three-slicer

Browser/WASM 3D-slicing kernel reverse-engineered from [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer). Slices binary STL to G-code entirely client-side (or in Node) — no server, no native binaries.

**No three.js dependency.** This is a headless SDK; the only dependency is `@three-slicer/data` (config metadata JSON). For a ready-made React viewer see `three-slicer/viewer`.

Ported from the original C++ sources: Clipper polygon ops, Arachne variable-width walls, real fill patterns (gyroid TPMS / honeycomb / 3D-honeycomb / crosshatch / concentric), tree supports, pressure equalizer, arc fitting (G2/G3), scarf seams, ironing, multi-material with prime tower. Kernel changes are gated by a 120+ invariant test suite and golden byte-identical G-code checks.

## Install

```bash
npm i three-slicer
```

## Usage

```js
import { createSlicer } from 'three-slicer'

const slicer = await createSlicer()               // loads the WASM kernel (~3.4 MB, base64-inlined)

// Batch: full result at once
const r = slicer.slice(stlArrayBuffer, { layer_height: 0.2, wall_loops: 2 })
console.log(r.stats.layers, r.gcode.length)

// Streaming: per-layer callbacks, frees each layer (OOM-resilient); result carries stats only
slicer.slice(stlArrayBuffer, params, {
  onProgress: (done, total) => {},
  onLayer: ({ z, idx, gcode, paths, widths }) => { /* accumulate */ },
})
slicer.dispose()
```

Off-main-thread (browser): `new Worker(engineWorkerURL(), { type: 'module' })` — the worker speaks a streaming protocol (`{type: 'layer' | 'done' | 'error' | 'progress'}`). Subpath `three-slicer/worker` exposes the worker entry for bundler-specific setups.

## Parameters

Two levels — use whichever fits:

1. **Kernel params (this package's native contract)** — a flat JSON object of ~50 keys (`layer_height`, `wall_loops`, `infill_density` 0–1, `sparse_infill_pattern`, `enable_support`, `wall_generator: 'classic' | 'arachne'`, …). See `src/settings.js` for the full shape.
2. **OrcaSlicer settings map** — a sparse `{schemaKey: value}` map using original OrcaSlicer option keys (923 defined in `@three-slicer/data`); unset keys fall back to schema defaults:

```js
import { deriveKernelParams } from 'three-slicer/settings'
slicer.slice(stl, deriveKernelParams({ layer_height: 0.25, sparse_infill_density: 15 }))
```

**Known limit:** `deriveKernelParams` maps a curated whitelist of ~50 schema keys to kernel params. Editing other schema keys has no slicing effect (they exist for UI/metadata). Vector options use their first element only.

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
