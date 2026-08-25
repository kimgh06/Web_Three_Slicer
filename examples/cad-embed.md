# cad-embed — Design-to-Print Feedback Loop

> The shared rules are in [DEMOS.md](./DEMOS.md). This document covers only what is specific to this demo.

> **Current status:** implemented — [`cad-embed/`](./cad-embed/) (`npm i && npm run dev`).
> How to run it and the measurements are in the app's [README](./cad-embed/README.md).
> Measured: an 80×50×4 bracket at 31m·10.5g → thickness alone to 8mm gives 39m·15.2g. Four rapid slider
> changes → one slice.
> One rule the spec did not have surfaced during implementation: a domain error must **invalidate the
> scheduled slice** (`loop.invalidate()`). Without it a stale result arrives a second later and overwrites
> the error message with "Up to date".
> Remaining: a deployment URL, a screenshot.

## What this demonstrates

An integration example where a web CAD/parametric design tool calls three-slicer as a **programmable
engine**, showing immediately how a design change affects print time and material use.

There is one question: **"what if you could see manufacturing cost while designing?"** Browser CAD of the
Tinkercad/Onshape kind keeps design and slicing as disconnected steps — the loop that removes that
disconnect is the protagonist here.

3MF round-trip is not covered by this demo — that protagonist is pinned to [marketplace](./marketplace.md).

The demo's hidden role: **API-design validation.** If building it requires touching package-private state,
what is lacking is the package API, not the demo (DEMOS.md §8 Phase 2).

## Target

browser CAD · generative design · product configurators · parametric design SaaS.

## Package APIs used

```
three-slicer/client   createSlicerClient() — slice / cancel / terminate
three-slicer/settings deriveKernelParams(settings) — host settings → kernel params
three-slicer/toggle   makeCfg/disabledKeys — reuse the option enable/disable rules in the host UI
three-slicer/viewer   (optional) <Viewport gcode={...}/> — delegate the slice-result preview to the viewer
```

## Install

This demo is an independent project deployed to a different site than the repository
([DEMOS.md §2](./DEMOS.md#2-independent-projects-and-installation)).

```bash
npm i three-slicer three react react-dom
```

`three` is needed for the parametric geometry generation and the CAD canvas; react/react-dom only when
Viewport is used. Showing statistics only, without Viewport, `npm i three-slicer three` is enough —
`client`, `settings` and `toggle` require no framework.

## The CAD part

No real CAD kernel is built. One parametric bracket made of three.js primitives:

```ts
interface BracketParams { width: number; height: number; thickness: number; holeDiameter: number }
```

Four sliders (Width/Height/Thickness/Hole). The screen is a two-way split, DESIGN (the 3D bracket) on the
left / PRINT FEEDBACK (print time · material · layers) on the right — for the wireframe see
[DEMOS.md](./DEMOS.md) §4.

## Slicing policy

Not an unbounded slice per parameter change:

```
Change → Change → Change → 700ms idle → slice only the latest geometry
```

`const RESLICE_DEBOUNCE_MS = 700` + cancel of the previous job. This pattern is itself the SDK-integration
example.

A generation id that increments per request keeps a terminated old worker's result from overwriting the
latest design's:

```js
let generation = 0
let timer

function scheduleSlice() {
  const mine = ++generation
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const result = await sliceCurrentGeometry()
    if (mine === generation) showFeedback(result)
  }, 700)
}
```

## Core API example (the code the README must show before any UI code)

```js
const client = createSlicerClient()
const params = deriveKernelParams(hostSettings)
const result = await client.slice(stlBytes, params, { onProgress })
if (result.error) throw new Error(result.error)
setManufacturingFeedback({
  printTimeSec: result.stats.time_estimate,
  filamentMm:   result.stats.filament_mm,   // the host converts to grams via diameter and density
})
```

## Implementation notes

- **The slice input is STL bytes.** A utility that serializes the parametric geometry (a three.js
  BufferGeometry) to binary STL is needed (three/examples' STLExporter, or ~30 lines by hand).
- **Cancel is conditional**: `client.cancel()` works only on the MT kernel (a cross-origin-isolated page).
  Otherwise a superseded slice is discarded by `terminate()` plus recreating the client — with the debounce
  in place, recreation is rare.
- **Filament is mm.** The gram display converts via the filament preset's diameter and density (the same
  formula as [instant-quote](./instant-quote.md)) — both demos use the same conversion, but at ~5 lines
  each no shared package is made.
- Using Viewport, **the host owns settings** and hands over only the result through the `gcode` prop — the
  host-control embed pattern that avoids running the kernel twice.
- `<Viewport/>` has no programmatic model-input prop. The CAD canvas displays the CAD geometry, and only
  the slicing result goes to Viewport through `gcode`. Turning `defaultAutoSlice` on as well would slice
  twice.
- Toggle: disable the controls named by `disabledKeys(makeCfg(settings))`. An `evalEnableIf()` `null` is
  not false — it means "cannot decide, fail open".

## State and errors

- Geometry-generation failure and slicing failure are separated, so the UI says which stage failed.
- While the debounce waits after a change, the previous numbers are labeled "previous design's result".
- CAD domain errors — a hole diameter breaching the bracket outline and the like — are blocked before the
  worker is ever called.
- A cancelled generation raises no error toast.

## What is intentionally mocked

- The CAD kernel (B-rep/feature tree) — a composition of three.js primitives is all there is.
- Saving, exporting, project management — none. The flow ends at the feedback loop.

## Definition of done

- [ ] 4 parametric controls + geometry regeneration
- [ ] the host owns the three-slicer state (settings)
- [ ] debounce + cancel of the previous slice (or the terminate fallback)
- [ ] automatic re-slice → print time · filament deltas shown
- [ ] viewer host-control (where used)
- [ ] feedback produced with no separate export/import step
- [ ] public exports only — needing private access reduces to a package-API issue

## E2E scenario

```
initial load → automatic slice → feedback shown
→ Thickness 4→8mm → exactly one re-slice after 700ms (intermediate changes cancelled)
→ filament and print time confirmed to increase
```

An additional regression scenario:

```text
move the Thickness slider quickly 10 times → exactly one slice completes, at the final value → no earlier
result overwrites the UI
```

## To add to the docs after implementation

- live URL and screenshot
- the actual run/build/test commands
- the bracket parameter ranges and units
- the file paths of the STL serializer and the debounce controller

## Production considerations

A real CAD integration additionally needs incremental geometry updates (instead of full re-serialization),
slice-result caching (revisiting identical parameters), a worker pool, and validation of the design's unit
system (mm is assumed).
