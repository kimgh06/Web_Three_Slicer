# CAD Embed — three-slicer demo

A demo using the slicer as a **programmable engine** inside a parametric design tool. Move a slider and the
print time and material use follow — no save, no export.

The integration is one file, [`src/print_feedback.js`](./src/print_feedback.js), and this loop is its core.

```js
const loop = createFeedbackLoop({
  makeWorker: () => new SlicerWorker(),
  onState: render,          // {status:'stale'|'slicing'|'ready'|'error', …}
})

// Called on every parameter change. After 700ms of quiet, only the last geometry is sliced.
loop.request(positions, settings)

// When the design becomes unsliceable (a hole larger than the part, and so on).
loop.invalidate()
```

`request()` does two things, and without either the integration looks broken:

1. **Debounce** — a slider drag must not queue a slice per pixel.
2. **Generation guard** — an already-stale slice's result must not overwrite the latest answer.
   The worker is FIFO, so a cancelled request still answers. **Discarding** the answer when it returns is
   the reliable side.

## Current status

It works. No deployment URL yet (`npm run build` → `dist/`, static hosting works).

Measured (M-series Mac, Chrome, P1S 0.4 / 0.20mm Standard / PLA Matte, a 404-facet bracket):

| Design | Result |
| --- | --- |
| 80 × 50 × 4 mm, 8 mm hole | 31m · 10.6 g · 19 layers |
| thickness alone 4 → 8 mm | 39m · 15.4 g · 39 layers (`+8m · +4.8 g`) |
| 80 × 20 × 8 mm, 8 mm hole | 17m · 4.6 g |

Four consecutive slider moves still run exactly one slice (`stale` ×4 → one `slicing`).

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

Move a slider, let go, and the numbers on the right refresh.

## Package APIs used

| Path | What is used |
| --- | --- |
| `three-slicer/client` | `createSlicerClient()` → `warmup()`, `slice()`, `cancel()`, `terminate()` |
| `three-slicer/settings` | `printerSettings`, `printerDefaultPreset`, `processPresets`, `filamentPresets`, `deriveKernelParams`, `settingScalar` |
| `three-slicer/toggle` | `makeCfg` + `disabledKeys` — the slicer's enable_if rules applied to the host controls as-is |
| `three-slicer/viewer/toolpath` | `buildSegmentData` / `makeToolpath` / `computeColors` — the toolpath refreshed on every re-slice |

`<Viewport/>` is not used. The design view is the host's own three.js scene and the slicer returns only
numbers — because what this demo sells is the "API", not a "screen". The 3MF round-trip belongs to
[marketplace](../marketplace.md) and is not covered here.

## Architecture

```
slider change
  → validate()            ─ CAD domain errors blocked before the worker is called (+ loop.invalidate())
  → makeBracket()         ─ three.js ExtrudeGeometry (a plate + a through hole)
  → trianglesOf()         ─ triangle soup (N*9)
  → loop.request()        ─ 700ms debounce + generation++
      → toBinarySTL()     ─ origin-centered, lowest point z=0 (not bed-centered)
      → client.slice()    ─ the worker
      → toFeedback()      ─ seconds · mm · g · layers
  → onState('ready')      ─ the delta against the previous values + toolpath refresh (toolpath_view.js)
```

## Run locally

```bash
npm i
npm run dev
npm run build && npm run preview
npm test       # the geometry/STL contract + one real slice + the 3 loop rules
```

## Important files

| File | Role |
| --- | --- |
| [`src/print_feedback.js`](./src/print_feedback.js) | **The whole integration.** Presets, STL serialization, the debounce/generation loop, stats conversion |
| [`src/bracket.js`](./src/bracket.js) | The parametric geometry + domain validation (the CAD side) |
| [`src/toolpath_view.js`](./src/toolpath_view.js) | Rendering the sliced paths. Copyable on its own |
| [`src/main.js`](./src/main.js) | The three.js scene, slider wiring, Vite worker creation |
| [`test_feedback.mjs`](./test_feedback.mjs) | The smoke test (loop rules verified with a fake worker) |

## State and errors

```
stale → slicing(progress) → ready
                          ↘ error
```

- **stale**: a value changed and the debounce is pending. The previous numbers stay, dimmed (not erased —
  "the previous design's result" is still valid information).
- **error**: the slice failed, or the design was unsliceable to begin with. The latter is caught by
  `validate()` before `makeBracket()` even runs.
- A cancelled generation is dropped silently — no error toast.

The real bug that appears without `invalidate()` (observed in this demo, then fixed): schedule a slice with
a valid change and then move to an invalid value, and a second later the stale result arrives, erases the
error message and flips it to "Up to date". The numbers on screen then describe a design other than the one
the sliders state.

## Viewing the sliced paths

Below the design the paths the slicer actually produced are drawn, **rebuilt on every re-slice** —
thickness 4 → 8 mm goes from 20 layers / 11,149 segments to 40 layers / 22,615 segments. The default is all
layers with travel included, and a slider cuts the stack.

The `loop` ships `layers` along with `onState('ready')`. With no `onLayer` callback given to
`client.slice()`, the client collects the layers, and that is exactly `buildSegmentData()`'s input shape —
no G-code re-parsing.

## The model is handed over origin-centered

`toBinarySTL()` moves the design to be centered on the **origin (0, 0)**, not the bed center. The kernel
takes plate-local coordinates and seats the part on the bed itself; pre-centering on the bed adds the
offset twice and the part slices off the bed. The only signal is `stats.over_bed_model`, so it is checked
after every slice.
The detailed measurements: [DEMOS.md §4.5](../DEMOS.md#45-coordinates-handed-to-the-kernel--plate-local)

## Why the worker is created by hand under Vite

Called with no argument, `createSlicerClient()` makes the worker with
`new URL('./src/slicer.worker.js', import.meta.url)`, and Vite treats that expression as an asset
reference, copying the worker file unprocessed. The copy still imports an unhashed `./slicer_core.js`, so
it 404s only in the production build (dev passes). So `main.js` creates it via
`three-slicer/worker?worker` and hands it over. `print_feedback.js` merely accepts a worker factory as an
argument and stays bundler-neutral.

## What is intentionally mocked

- The CAD kernel — no B-rep, no feature tree. One three.js `ExtrudeGeometry` is all of it.
- Saving, projects, version control — none. The flow ends at the feedback loop.

## Production considerations

- **Incremental geometry updates**: today every parameter change rebuilds and re-serializes the whole
  mesh. Negligible at 404 facets, but a real CAD model (hundreds of thousands) wants only the changed part
  rebuilt.
- **Result caching**: returning to the same parameter combination is common. A cache keyed on
  `JSON.stringify(params)` almost eliminates worker calls when a slider moves back and forth.
- **A worker pool**: one FIFO worker today. Comparing several designs concurrently needs a pool.
- **Units**: the kernel assumes mm. Inch-based CAD must convert just before serialization.
- `cancel()` is a true cancel only on a cross-origin-isolated page; otherwise it is a worker restart. With
  the debounce it is rarely needed, but for large models enabling COOP/COEP is the better route.
