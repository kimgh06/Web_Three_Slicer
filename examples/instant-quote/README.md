# Instant Quote — three-slicer demo

A quote page that actually slices the model in the browser, gets print time and material use, and puts a
price on top. The model never goes to a server.

The whole integration is one file, [`src/estimate.js`](./src/estimate.js), and this is its core. The file
imports nothing besides `three-slicer`, so it can be copied out as-is.

```js
import { createSlicerClient } from 'three-slicer/client'
import { deriveKernelParams, printerSettings, processPresets, filamentPresets } from 'three-slicer/settings'

// 1. Merge presets in printer → quality → material order. Each catalog's keys are cleared first because a
//    preset carries only the keys it sets — without clearing, the previous pick survives underneath.
const settings = buildSettings(catalog, { printer, process, filament })

// 2. Slice in the worker. Passing params as an object is fine — the client serializes it.
//    The caller creates and hands over the worker — in Vite, `three-slicer/worker?worker` (see below).
const client = createSlicerClient(makeWorker())
const result = await client.slice(stlBytes.slice(0), deriveKernelParams(settings), { onProgress })
if (result.error) throw new Error(result.error)

// 3. stats are seconds and filament length (mm). Weight is converted via diameter and density.
const { time_estimate: seconds, filament_mm: lengthMm } = result.stats
const grams = lengthMm * Math.PI * (diameter / 2) ** 2 * density / 1000
```

## Current status

It works. No deployment URL yet — it goes onto static hosting as-is (`npm run build` → `dist/`).

Measurements (M-series Mac, Chrome, 20mm cube / P1S 0.4 / 0.20mm Standard / PLA Matte):

```
Model parse       0 ms
Kernel warmup   110–160 ms
Slicing          21–50 ms
Result          12m · 4.1 g (1.29 m) · 99 layers · US$2.92   (single-threaded kernel)
```

**The time estimate depends on the kernel.** Run the same build and the same model on a page with
COOP/COEP enabled and the multithreaded kernel is selected; the result becomes **15m · US$3.08**. The
geometry (99 layers, 8,095 segments) and the filament (4.1 g / 1.29 m) are **exactly identical** — only
`time_estimate` differs, by 25%. The worker log shows which ran (`[slicer.worker] core: st` vs
`core: mt (threads)`). Since this value feeds the quote, the deployment's header configuration changes the
price — better to pick one as the reference and pin the headers.

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

On the first screen press **Use the sample cube**, then **Calculate quote** — that is all.

## Package APIs used

| Path | What is used |
| --- | --- |
| `three-slicer/client` | `createSlicerClient()` → `warmup()`, `slice()`, `cancel()`, `terminate()` |
| `three-slicer/settings` | `printersByVendor`, `printerSettings`, `printerDefaultPreset`, `printerKeys`, `processPresets`, `filamentPresets`, `deriveKernelParams`, `settingScalar` |
| `three-slicer/viewer/loaders` | `loadModel()` — STL/OBJ/3MF/AMF/PLY into the same `modelPos` |
| `three-slicer/viewer/toolpath` | `buildSegmentData` / `makeToolpath` / `computeColors` / `roleRatios` — rendering the sliced paths |

Deliberately not used: `three-slicer/viewer` (the Viewport component), `three-slicer/components`.
`viewer/toolpath` is a **geometry builder**, not a UI component, so the scene, camera and controls are this
demo's own — the claim that the SDK stands without the viewer UI holds. React remains unused too.

## Architecture

```
file drop / sample
  → loadModel()             ─ every format into modelPos (N*9)
  → show bbox and triangle count
  → merge the 3 presets      ─ buildSettings()
  → build volume check       ─ overBed()
  → serialize STL origin-centered ─ toBinarySTL() (not bed-centered — see below)
  → client.slice()          ─ worker, inside the browser
  → stats → toEstimate()    ─ seconds · mm · g · layers
  → priceOf()               ─ mock/pricing.js (the file to replace)
  → result.layers → toolpath ─ toolpath_view.js (the quote's basis, visible)
```

## Run locally

```bash
npm i          # installs three-slicer from npm (not a workspace link)
npm run dev
npm run build  # dist/ — static hosting works
npm test       # the integration file's contract + one real slice
```

## Important files

| File | Role |
| --- | --- |
| [`src/estimate.js`](./src/estimate.js) | **The whole integration.** Catalog, preset merging, STL serialization, slicing, stats conversion |
| [`src/mock/pricing.js`](./src/mock/pricing.js) | The pricing formula — the file a real service replaces |
| [`src/toolpath_view.js`](./src/toolpath_view.js) | Rendering the sliced paths (three + viewer/toolpath). Copyable on its own |
| [`src/main.js`](./src/main.js) | DOM wiring + Vite worker creation. No framework, no state library |
| [`vite.config.js`](./vite.config.js) | ES workers, es2022, `optimizeDeps.exclude` |
| [`test_estimate.mjs`](./test_estimate.mjs) | The smoke test |

## State and errors

`idle → loading-model → ready → slicing → completed | cancelled | error`.

Progress uses the worker's `onProgress(done, total)` directly (no fake animation). The stretch where
`total` is 0 shows as "Preparing slicer…". Handled errors: file-parse failure, build-volume exceeded (with
the exceeded axis and dimensions), missing preset, slice failure, and no extrusion (zero time or zero
filament) — all announced with `role="alert"`.

Cancel has two paths. `client.cancel()` is a flag the kernel reads inside its C++ loop, and the flag lives
in a SharedArrayBuffer, so it works **only on a cross-origin-isolated page**. Otherwise the worker is
terminated and recreated — this demo's default, and the next quote pays warmup again. To enable COOP/COEP
and the multithreaded kernel, uncomment `server.headers` in `vite.config.js`.

## Viewing the sliced paths

Below the quote card the actual toolpath is drawn — the default is **all layers, travel included**, and a
slider cuts the stack or toggles travel off. The role ratios (Sparse/Wall/Solid/Skirt) come from
`roleRatios()`, computed over extrusion length.

The layers used here are `result.layers` from `client.slice()`. With no `onLayer` callback the client
collects the streamed layers as `[{z, paths, widths}]`, which is exactly the shape `buildSegmentData()`
takes — **no G-code re-parsing needed.** (Role information is only accurate on this path — see the
[farm-dashboard README](../farm-dashboard/README.md#three-things-measurement-revealed) for the details.)

## The model is handed over origin-centered

`toBinarySTL()` moves the model to be centered on the **origin (0, 0)**, not the bed center. The kernel
takes plate-local coordinates and seats the part on the bed itself, so pre-centering on the bed adds the
offset twice and the part slices off the bed — the time and material still come out plausible and no error
is raised. The only signal is `stats.over_bed_model`, so it is checked after every slice.
The detailed measurements: [DEMOS.md §4.5](../DEMOS.md#45-coordinates-handed-to-the-kernel--plate-local)

## Why the worker is created by hand under Vite

Called with no argument, `createSlicerClient()` makes the worker with
`new URL('./src/slicer.worker.js', import.meta.url)`. Vite treats that expression as an asset reference and
**copies the worker file unprocessed**, so the copy still imports an unhashed `./slicer_core.js` and 404s
in the production build. The dev server serves the sources as-is and runs fine, so **it only shows up after
`vite build`** (measured in this demo: dev fine, preview fails with
`Failed to fetch dynamically imported module: /assets/slicer_core.js`).

So `main.js` creates the worker via `three-slicer/worker?worker` and hands it to `createEstimator()`.
`estimate.js` merely accepts a worker factory as an argument, staying bundler-neutral, and imports nothing
outside `three-slicer/*`.

## What is intentionally mocked

- **The price.** `filamentPricePerKg` 25, `machineHourlyRate` 3, `handlingFee` 2, `marginMultiplier`
  1.08 — not real market prices, and the UI says so.
- Payment, ordering, shipping, accounts — none. The flow ends at the quote card.

## Privacy

No model-upload request occurs during slicing (verifiable in the devtools Network tab).
Even with analytics attached, the filename, original size and geometry hash are never sent.

## Production considerations

- Pricing: labor, machine depreciation, failure rate, support removal, shipping, tax, minimum order.
- Quoting several models on one plate together needs plate layout. This demo places one file, alone, at
  the bed center.
- Large models stretch warmup and slicing. If cancel is genuinely needed, enabling COOP/COEP for the
  multithreaded kernel is the better route.
- The bundle is large because of the kernel WASM. Deferring warmup past first visit, starting it when a
  file is picked, is one option.
