# three-slicer

Browser/WASM 3D-slicing kernel reverse-engineered from [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer). Slices binary STL to G-code entirely client-side (or in Node) — no server, no native binaries.

**No three.js dependency.** This is a headless SDK with zero runtime dependencies; the config metadata it reads ships inside the same package (`three-slicer/data`). For a ready-made React viewer see `three-slicer/viewer`.

Ported from the original C++ sources: Clipper polygon ops, Arachne variable-width walls, real fill patterns (gyroid TPMS / honeycomb / 3D-honeycomb / crosshatch / concentric), tree supports, pressure equalizer, arc fitting (G2/G3), scarf seams, ironing, multi-material with prime tower. Kernel changes are gated by a 120+ invariant test suite and golden byte-identical G-code checks.

## Install

```bash
npm i three-slicer
```

## Usage

```js
import { createSlicer } from 'three-slicer'

const slicer = await createSlicer()               // loads the WASM kernel (~3.3 MB, base64-inlined)

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

1. **Kernel params (this package's native contract)** — a flat JSON object of ~90 keys (`layer_height`, `wall_loops`, `infill_density` 0–1, `sparse_infill_pattern`, `enable_support`, `wall_generator: 'classic' | 'arachne'`, …). See `src/settings.js` for the full shape.
2. **OrcaSlicer settings map** — a sparse `{schemaKey: value}` map using original OrcaSlicer option keys (923 defined in `three-slicer/data`); unset keys fall back to schema defaults:

```js
import { deriveKernelParams } from 'three-slicer/settings'
slicer.slice(stl, deriveKernelParams({ layer_height: 0.25, sparse_infill_density: 15 }))
```

**Known limit:** `deriveKernelParams` maps a curated whitelist of 92 schema keys to kernel params. Editing other schema keys has no slicing effect (they exist for UI/metadata). Scalar options use their first element only; the filament options listed under *Materials* below are the exception — those keep every extruder's entry.

## Materials and multi-material

A material is a **filament preset**: a set of schema values (temperatures, flow, diameter, cooling, retraction/z-hop overrides) that a printer profile declares itself compatible with. Read the catalog through the facade, never by decoding `three-slicer/data/filaments.js` by hand:

```js
import { filamentPresets, deriveKernelParams } from 'three-slicer/settings'

const filaments = await filamentPresets()               // lazy — the artifact loads on first call
filaments.listFor('Bambu Lab X1 Carbon 0.4 nozzle')     // [{name, type, vendor}, …]
filaments.recommendedFor('Bambu Lab X1 Carbon 0.4 nozzle')  // the vendor's shortlist, filtered to the compatible set
Object.assign(settings, filaments.settingsFor('Bambu PLA Basic @BBL X1C'))
```

**One material per extruder.** Upstream stores every filament option as one entry per extruder, so a multi-material settings map writes each extruder's material at its own index:

```js
const params = {
  ...deriveKernelParams({
    nozzle_temperature: [255, 220],      // T0 ABS, T1 PLA
    filament_flow_ratio: [0.95, 1.0],
  }),
  // -> { extruder_nozzle_temp: [255, 220], extruder_flow_ratio: [0.95, 1.0], … }
  extruder_count: 2,                     // not a derived key — set it on the params directly
}
```

The kernel reads those arrays **positionally** and reloads the whole loaded-filament set — diameter, flow, retraction length/speed, z-hop, plus an `M109` when the temperatures actually disagree — at every `T` change. A single-element (or absent) option produces **no** `extruder_*` array at all, and the kernel then reads its scalars exactly as before, so a single-material slice is byte-identical to what it was before this feature existed.

`support_filament` / `support_interface_filament` are 1-based filament indices (`0` = "Default", keep the loaded tool) selecting which extruder prints the support base/raft and the support interface. `0` is omitted from the params rather than sent, so it emits no `T` command anywhere and leaves the support G-code byte-identical.

### Painting a region onto another extruder

Painting is the only way a **single** object can print in two materials — there is no triangle boundary to split on, only painted facets. The painted facets of each state are projected per layer and the sliced polygon is partitioned against them; where two extruders claim the same area the higher-numbered one wins (a total order on a small integer, so the result never depends on paint or clipper ordering).

Painting states are upstream's `EnforcerBlockerType`, one enum serving two jobs: `1` = ENFORCER = **Extruder1**, `2` = BLOCKER = **Extruder2**, `3..16` = Extruder3..16. The state-addressed protocol lives on the worker (`three-slicer/worker`); the direct handle's `slice.paint({enforcer})` is the original boolean pair only.

```js
worker.postMessage({ cmd: 'prepare', stl })                          // -> {type:'prepared', facets}
worker.postMessage({ cmd: 'paint', state: 3, facet, hx, hy, hz, cx, cy, cz, radius, states: [1,2,3] })
//   -> {type:'painted', enf, blk, counts: {1: n, 2: n, 3: n}}
worker.postMessage({ cmd: 'erase', facet, hx, hy, hz, cx, cy, cz, radius })   // back to the default extruder
```

`erase` is its **own command**, not `{cmd:'paint', state: 0}`: embind coerces a JS `false` to the int `0` == NONE, and the legacy blocker brush sends exactly that `false` — so the state path rejects `0` outright and only `erase`, which takes no state argument, can clear anything. A message without `state`/`states` gets the original reply verbatim, so existing listeners are unaffected.

Two consequences worth knowing before you build on this:

- Because one selector serves both jobs, **a support BLOCKER paint and an Extruder2 paint are the same mark**, and a facet can hold only one of them. The two brushes are therefore mutually exclusive, which is a data constraint, not a UI simplification.
- The painted multi-material path is taken only when support is **off** — it emits no support at all. **Paint and support cannot currently produce two materials together.**

Results carry the split: `stats.filament_mm_by_tool` (indexed by tool number, one slot per extruder, sums to `filament_mm`) and `stats.filament_mm_purge` (the prime/wipe tower share, already included in the per-tool figures). In the streamed toolpath, `paths[k+3]` encodes `role + tool * 16` — mask with `& 15` for the role and `>>> 4` for the tool.

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
