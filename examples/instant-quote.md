# instant-quote — automatic quoting for an FDM print service

> The shared rules (directories, state machine, error handling, performance display, fixtures) are in
> [DEMOS.md](./DEMOS.md). This document covers only what is specific to this demo.

> **Current status:** implemented — [`instant-quote/`](./instant-quote/) (`npm i && npm run dev`).
> This document remains the spec; how to run it, the file layout and the measurements are in the app's
> [README](./instant-quote/README.md).
> Measured (20mm cube / P1S 0.4 / 0.20mm Standard / PLA Matte): 12m · 4.0g · 99 layers, slicing 21–48ms.
> Remaining: a deployment URL, a screenshot, the `benchy-small.stl` fixture.

## What this demonstrates

A **headless** demo that runs **real slicing in the browser** when the user picks a model, and computes an
instant FDM quote from print time and filament use.

What it proves: **an FDM quote can be computed from actual slicer output without sending the model to a
server.** It is also the demo that shows three-slicer standing alone as an SDK without the viewer, so
`three-slicer/viewer` and `three-slicer/components` are deliberately not used.

Reference UX: Hubs (option change → live quote refresh), Treatstock (material/support cost factors),
Craftcloud (upload → manufacturing-condition flow). The point is not to clone them but to sell the
difference — "the model never leaves the browser". Scope is FDM only — it must not look like an
SLS/MJF/SLA quoting engine.

## Target

FDM print services · small print farms · on-demand manufacturing platforms · quote-widget SaaS.

## Package APIs used

```
three-slicer/client         createSlicerClient() → slice(stl, params, {onProgress}), terminate()
three-slicer/settings       printerSettings(name), processPresets(), filamentPresets(),
                            deriveKernelParams(settings), settingScalar(settings, key)
three-slicer/viewer/loaders loadModel(name, buffer) — file parsing and showing dimensions
```

Not used: `three-slicer/viewer`, `three-slicer/components`.

## Install

This demo is an independent project deployed to a different site than the repository
([DEMOS.md §2](./DEMOS.md#2-independent-projects-and-installation)).

```bash
npm i three-slicer three
```

`three` is needed not for the viewer but because `three-slicer/viewer/loaders` imports three
(the STL/OBJ/PLY/AMF loaders). `three-slicer/client` and `/settings`, on the other hand, import nothing, so
**building this in vanilla JS without React is recommended** — "this SDK requires no framework" is the extra
fact this demo can prove, and the integration file (`quote.js`) then drops into any app as-is.

## Screen

Four stages: initial → file loaded → computing → result. For the wireframe see [DEMOS.md](./DEMOS.md) §1.
Two lines of copy are fixed:

```
Your model never leaves this browser.      (the initial drop zone)
Demo pricing formula — not a commercial quote.   (the result card)
```

## Architecture

```
file drop (STL/3MF)
  → parse with loadModel() → show dimensions and filename
  → pick printer / filament / process presets (settings API)
  → merge the picked presets → deriveKernelParams()
  → client.slice(stlBuffer, params, { onProgress })   ← worker, inside the browser
  → result.stats → pricing formula → quote card
```

## Minimal implementation order

1. Read the file with `loadModel()` and show the dimensions from the union of every object's bbox.
2. After a printer is picked, expose only the processes/materials compatible with that machine.
3. When a profile of one type changes, delete the previous pick's keys before merging the new settings
   ([the shared settings contract](./DEMOS.md#6-the-settings-and-preset-application-contract)).
4. Hand the worker the original bytes for STL; for 3MF/OBJ and the rest, serialize `modelPos` to binary STL.
5. Turn `stats` into the quote inputs, and mark the previous result stale when an option changes.

## Core API example

```js
const input = stlBytes.slice(0) // client.slice() transfers the buffer to the worker
const result = await client.slice(input, deriveKernelParams(settings), {
  onProgress(done, total) {
    setProgress(total > 0 ? done / total : 0)
  },
})

if (result.error) throw new Error(result.error)

const { time_estimate: seconds, filament_mm: lengthMm } = result.stats
const radiusMm = Number(settingScalar(settings, 'filament_diameter') ?? 1.75) / 2
const density = Number(settingScalar(settings, 'filament_density') ?? 1.24)
const grams = lengthMm * Math.PI * radiusMm ** 2 * density / 1000
```

## Implementation notes (mapping onto the real API)

- **Stats fields**: print time is `result.stats.time_estimate`, filament is `result.stats.filament_mm`.
- **Filament is a length (mm), not a weight.** The gram display is the demo's own conversion:
  `grams = filament_mm × π × (diameter/2)² × density(g/cm³) / 1000`
  — diameter and density are read from the picked filament preset (`filament_diameter`,
  `filament_density`).
- **The slice input is STL bytes.** An STL upload passes its original buffer through; 3MF needs one demo
  utility that serializes the geometry `loadModel()` returned into binary STL (position array →
  50 bytes/tri, ~30 lines).
- **The worker input is transferred.** To slice the same bytes again or reuse them for dimension math,
  clone with `slice(0)` before handing them over.
- **Cancel is conditional.** `client.cancel()` rides a SharedArrayBuffer, so it works only on a
  cross-origin-isolated page (the MT kernel) and returns `false` otherwise. On a static deployment
  (no COOP/COEP headers), implement cancel as `terminate()` plus recreating the client.

## Pricing formula

No real business algorithm is built.

```js
const quoteConfig = { filamentPricePerKg: 25, machineHourlyRate: 3, handlingFee: 2, marginMultiplier: 1.08 };
price = (materialCost + machineCost + handlingFee) * marginMultiplier * quantity;
```

## What is intentionally mocked

- The pricing constants — the UI states they are not real market prices.
- Payment, ordering, shipping — none. The flow ends at the quote card.

## Proving the privacy claim

The heart of this demo. The UI shows "Local slicing — Your model stays on this device."
The devtools Network tab must show zero model-upload requests during slicing.

The automated check inspects that no request body after the upload carries the model bytes. Even if
analytics is added, it must not send the filename, the original size, or a geometry hash.

## Errors and retry

- When a profile lookup returns `null`, disable the slice button and say which pick is missing.
- When `stats.time_estimate === 0` or `stats.filament_mm <= 0`, compute no price and show the result as
  "cannot quote".
- Exceeding the build volume links to a printer change, using `stats.over_bed_model` and the exceeded axis.
- After a cancel, do not keep the last successful quote around as if it were a fresh one.

## Definition of done

- [ ] STL upload / 3MF geometry upload
- [ ] printer · filament · process preset picking
- [ ] browser worker slicing + real progress display (no fake animation)
- [ ] cancel (`cancel()` on MT, terminate+recreate otherwise)
- [ ] print time · filament weight/length output
- [ ] price computed, re-slice on option change
- [ ] core features run from a static deployment with no network

## E2E scenario

```
benchy-small.stl → Generic PLA → P1S → 0.20 mm → Slice
→ stats.time_estimate > 0 → stats.filament_mm > 0 → quote > 0
```

One failure path is pinned as well.

```text
pick a corrupted .3mf → user-facing error shown → Replace file → calibration-cube.stl → a normal quote
```

## To add to the docs after implementation

- live URL and screenshot
- the actual `npm run dev`, `npm run build`, `npm test` commands
- where the pricing constants live and how to change them
- fixture provenance and license

## Production considerations

A real quoting service additionally has to price in labor, machine depreciation, failure rate, support
removal, shipping, tax, and a minimum order. This demo's formula shows only the slicer-stats → price link.
