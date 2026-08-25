# Print Farm — three-slicer demo

An architecture demo managing several printers on one screen while **the operator's browser does the
slicing**. There is no backend — a single static page runs it.

The integration is one file, [`src/submit_job.js`](./src/submit_job.js), and this function is the demo's
entire claim.

```js
// Slice with the target printer's profile and build the payload that goes on the queue.
export async function prepareJob({ client, model, printer, onProgress }) {
  const settings = await settingsForPrinter(printer.model)          // a different profile per machine
  const result = await client.slice(toBinarySTL(model), deriveKernelParams(settings), { onProgress })

  return {
    payload: {
      name: model.name, printerId: printer.id,
      gcode: result.gcode,                                          // text
      layers: result.stats.layers,
      seconds: result.stats.time_estimate,
      grams: /* filament_mm → g */,
    },
  }
}
```

Neither the model, nor vertex buffers, nor file paths leave this function. So this payload is also
**everything a queue server would have received**, and it is inspectable on screen as-is.

## No backend — why is this still a distributed-architecture demo

This page is a demo, so it has to run from static hosting — hence no backend. The queue, printer state and
mock printers live in [`src/farm_store.js`](./src/farm_store.js), and that file is built **in the server's
shape**.

| store method | corresponding HTTP |
| --- | --- |
| `snapshot()` | `GET /api/state` |
| `addJob(payload)` | `POST /api/jobs` — the only call that carries data |
| `setOnline(id, on)` | `POST /api/printers/:id/online` |
| `gcodeOf(jobId)` | `GET /api/jobs/:id/gcode` |
| `subscribe(fn)` | `GET /api/events` (SSE/WebSocket) |

The claim is not "there is no server" but **"even with a server, no slicer is needed on it"**. Two things
are left inspectable:

1. **The to-be-transmitted payload is shown on screen** — after a slice, the "What a queue server would
   receive" panel shows `{name, printerId, gcode: "<309 kB of G-code text>", layers, seconds, grams}`
   verbatim.
2. **`farm_store.js` imports nothing** — `test_submit.mjs` checks that its import list is empty. Move this
   file to a server as-is and that is the slicer-less queue server.

## Current status

It works. Deployable from the static build alone (`npm run build` → `dist/`).

Measured (M-series Mac, Chrome, 20mm cube):

| Target | Result | G-code |
| --- | --- | --- |
| Printer 01 (P1S 0.4) | 12m · 4.1 g · 99 layers | 309 kB |
| Printer 03 (MK4 0.4) | 20m · 4.1 g · 99 layers | 312 kB |

The same model taking different times is the machine profiles' motion limits actually applying.
Re-parsing the G-code stored in the queue yields 99 layers · 8,658 segments.

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

**Use sample cube** → pick a target printer → **Slice & queue**. The job lands in the queue, the mock
printer starts climbing layers, and clicking a queue row shows that job's toolpath.

The farm starting empty is deliberate: **a job exists only after a slice, and only this browser can
slice.** With a server it would be no different.

## Package APIs used

| Path | What is used |
| --- | --- |
| `three-slicer/client` | `createSlicerClient()` — slicing with the target machine's profile per job |
| `three-slicer/settings` | `printerSettings`, `printerDefaultPreset`, `processPresets`, `filamentPresets`, `deriveKernelParams`, `settingScalar` |
| `three-slicer/viewer/loaders` | `loadModel()` — STL/OBJ/3MF/AMF/PLY |
| `three-slicer/viewer/gcode` | `parseGcode()` — stored G-code back into layers |
| `three-slicer/viewer/toolpath` | `buildSegmentData` / `makeToolpath` / `computeColors` |

## Architecture

```
the browser (inside one tab)
──────────────────────────────────────────────────────────
read the model      loadModel
target profile      settingsForPrinter
slice               client.slice          ← the only compute
build the payload   prepareJob            → {gcode, numbers}   ← all that would cross the network
   │
   └─▶ farm_store  addJob / snapshot / subscribe / gcodeOf   ← the point a server replaces
          │            the mock printer climbs layers
          ▼
re-parse G-code     parseGcode
render the toolpath makeToolpath          (default: all layers. "Follow print progress" limits
                                          the display to the layer the printer has reached)
```

## Run locally

```bash
npm i
npm run dev
npm run build && npm run preview   # the static output behaves identically
npm test                           # payload check + a real slice + queue behaviour
```

## Important files

| File | Role |
| --- | --- |
| [`src/submit_job.js`](./src/submit_job.js) | **The whole integration.** Profiles, STL serialization, slicing, payload construction |
| [`src/farm_store.js`](./src/farm_store.js) | Queue, printer state, mock printers. The slot a server replaces |
| [`src/toolpath_view.js`](./src/toolpath_view.js) | Toolpath rendering (three + viewer/toolpath). Three demos copy this same file |
| [`src/main.js`](./src/main.js) | The dashboard UI |
| [`test_submit.mjs`](./test_submit.mjs) | The smoke test |

## The mock boundary

- **All printer hardware.** A timer in `farm_store.js` climbs the layers. No Moonraker/OctoPrint/Bambu
  protocol implementations — the adapter is not what this demo sells. A real adapter just needs the same
  shape: take a job, report progress, finish or fail.
- **No persistence.** A refresh clears the queue. Correct behaviour for a demo page.
- **No auth, no multi-user.** One operator, one tab assumed.

## Three things measurement revealed

**(1) The model must reach the kernel origin-centered.** Handing it over bed-centered makes the kernel
seat it on the bed again, adding the offset twice. On a 250 × 210 bed the cube sliced at X 234.7–265.4 —
off the bed — while the time and material looked fine. The only signal is `stats.over_bed_model`, and to
the eye it shows only **once the toolpath is drawn** (the part appeared as a dot in a corner). The flag is
now checked after every slice. [DEMOS.md §4.5](../DEMOS.md#45-coordinates-handed-to-the-kernel--plate-local)

**(2) The kernel's G-code carries no `;TYPE:` role comments.** Re-parsing stored G-code therefore
reconstructs the geometry exactly but **not the roles** — as `parseGcode`'s docs say, unknown roles fall
back to wall. The same cube drawn from the kernel's layer stream reads
`Sparse 43% · Wall 38% · Solid 16% · Skirt 3%`; drawn from the G-code round-trip it reads
`Wall 94% · Skirt 6%`. This demo's colors are therefore an approximation, and the screen says so. For
accurate roles, draw the slice result's `layers` directly, as instant-quote/cad-embed do.

**(3) `SegmentData.position` is stride 4** (x, y, z, w). The type declaration says only `Float32Array`,
and reading it at stride 3 shuffled the coordinate channels and pointed the camera at nowhere. Computing a
toolpath bbox by hand means reading at stride 4. `data.bbox` includes travel, and the first layer carries
the printer's prime line — fitting the camera to the part means excluding both.

## Production considerations

A real service needs the backend — two operators must see the same queue, jobs must survive a refresh, and
someone else's job's G-code must open too. What this demo shows is **how thin that backend is allowed to
be**.

- **The swap point**: replace `farm_store.js`'s five methods with fetch/SSE and it is done. The call sites
  already have that shape.
- **G-code storage**: one job is hundreds of kB to tens of MB. Object storage + an expiry policy.
- **Event application**: today every event re-reads the snapshot. At scale, apply events to local state
  and detect falling behind via `revision` only.
- **Printer adapters**: Moonraker/OctoPrint/Bambu, reconnection, offline queues, failure retries.
- **Permissions**: who may submit a job to which printer.
- More operators do not thicken the backend — each slices in their own browser.
