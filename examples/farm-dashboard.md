# farm-dashboard — Client-compute Print Farm

> The shared rules are in [DEMOS.md](./DEMOS.md). This document covers only what is specific to this demo.

> **Current status:** implemented — [`farm-dashboard/`](./farm-dashboard/) (`npm i && npm run dev`).
> How to run it and the measurements are in the app's [README](./farm-dashboard/README.md).
> Measured: the same cube at P1S 12m / MK4 20m, G-code 309–312 kB.
>
> **The big departure from the spec: there is no backend.** This is meant to be shown as a demo page, so it
> has to work from static hosting — that decision follows. The queue, printer state and mock printers live
> in `src/farm_store.js`, and that file keeps the server's shape (`snapshot()` = GET /api/state,
> `addJob()` = POST /api/jobs …). The architecture claim is upheld by **showing the payload that would be
> transmitted, on screen** — G-code text and three numbers, nothing else; the model never leaves the tab.
> `test_submit.mjs` checks that payload and the queue behaviour (an offline printer starts no job).
> In-process events instead of WebSocket; the farm starts empty (no job without a slice).
> Remaining: a deployment URL, a screenshot.

## What this demonstrates

A distributed print-farm architecture demo: jobs across several printers are managed, but **the slicing
compute runs in the operator's browser** — the server only relays the queue and state.

What it proves: **N printers do not require the slicing server to grow.** Reproducing
SimplyPrint/3DQue's printer-management features is not the goal — their dashboard shape is borrowed to show
the architecture.

Implementation priority is last — this is more an architecture demonstration than core Three Slicer
validation.

## Target

Small print farms · university fab labs · in-house printer pools · print-management SaaS developers.

## Package APIs used

```
three-slicer/client           createSlicerClient() — slice with the target machine's profile per job
three-slicer/settings         printerSettings(model) — matching the printer card's machine to a profile
three-slicer/viewer/gcode     parseGcode(text) — re-parsing and inspecting stored G-code
three-slicer/viewer/toolpath  buildSegmentData/makeToolpath — the running job's layer preview
```

## Install

An independent project deployed to a different site than the repository, and with no backend it ends at
static hosting ([DEMOS.md §2](./DEMOS.md#2-independent-projects-and-installation)).

```bash
npm i three-slicer three
```

`makeToolpath` does not import three — it takes it as an argument — but the demo renders its own scene, so
three is a dependency of the client.

## The queue (no backend, but backend-shaped)

Responsibilities: job metadata · G-code storage · printer state · the queue · events.
**What it never does: STL parsing, slicing, G-code generation.**

In this demo `src/farm_store.js` plays that role, its methods 1:1 with the HTTP contract — so swapping in a
server later means no redesign at the call sites.

```text
snapshot()          GET  /api/state
addJob(payload)     POST /api/jobs      {name, printerId, gcode, layers, seconds, grams}
setOnline(id, on)   POST /api/printers/:id/online
gcodeOf(jobId)      GET  /api/jobs/:id/gcode
subscribe(fn)       GET  /api/events    (SSE / WebSocket)
```

The `addJob` payload carries no STL/3MF, no vertex buffers, no original file paths. The queue stores G-code
as an opaque payload — it neither interprets nor re-slices it. Putting that payload on screen, verifiable
as-is, is this demo's method of proof.

## Mock printers

Four, fixed (exactly the DEMOS.md §3 fixture): P1S×2 (printing/idle) + MK4×2 (queued/offline).
The adapter is realistic in interface only:

```ts
interface PrinterAdapter {
  getStatus(): Promise<PrinterStatus>
  submitJob(job: PrintJob): Promise<void>
  pause(): Promise<void>; resume(): Promise<void>; cancel(): Promise<void>
}
class MockPrinterAdapter implements PrinterAdapter { ... }
```

No Moonraker · OctoPrint · Bambu protocol implementations — the adapter itself is not what the demo is
about.

## Screen

A grid of 4 printer cards (state · progress · current layer) + the Job Queue list. For the wireframe see
[DEMOS.md](./DEMOS.md) §3.

## Architecture / the core flow

```
Add Job → pick an STL → pick the target printer
  → browser slice with printerSettings(target machine) + the process preset   ← client
  → payload is G-code + the numbers only                                      ← the original model never goes
  → queue registration (farm_store) → the mock printer emits progress events
  → the card shows toolpath layer progress from the parseGcode result
```

## Implementation notes

- **The toolpath stream's role field is encoded**: `enc = role + tool*16` (`paths[k+3]` at stride 8).
  Readers must mask — `& 15` is the role, `>>> 4` the tool.
- `makeToolpath` does not import three — **it takes the THREE namespace as an argument**; hand it the
  demo's own three instance to guarantee a single instance.
- Progress (the current layer) maps the mock printer event's layer index onto `parseGcode(...).layers`.
- The parser result has the shape `const parsed = parseGcode(gcode)`, and the toolpath gets
  `buildSegmentData(parsed.layers, defaultLineWidth)`.
- Every event re-reads the snapshot. With a real server, apply events to local state and detect falling
  behind via `revision` only (which is why the store also exports a `revision`).
- With no backend, a refresh clears the queue. For a demo page that is the right behaviour.

## Job states

```ts
type JobState = 'slicing' | 'queued' | 'printing' | 'paused' | 'completed' | 'failed' | 'cancelled'
```

No job is created before the browser slice succeeds. Submitting to an offline printer leaves the job
`queued`; it turns `printing` only after that printer comes online.

## Proving the distributed compute

The dashboard shows two things:

```
This browser                      Jobs sliced: 4
A backend, if you added one       Slices it would perform: 0
```

And **the payload itself** — G-code text and three numbers. Even without a backend, "what would cross the
network" is inspectable.

## What is intentionally mocked

- All printer hardware (MockPrinterAdapter's timer-driven progress events)
- Auth and multi-user — none. A single operator is assumed.

## Definition of done

- [ ] 4 printer cards + per-printer state
- [ ] add job → target machine profile matched → browser slicing
- [ ] generated G-code queued, queue displayed
- [ ] mock printer progress (realtime events)
- [ ] G-code toolpath shown (whole model by default, progress-following optional)
- [ ] **no slicer dependency in the queue code** — `farm_store.js` imports nothing
- [ ] the to-be-transmitted payload verifiable on screen

## E2E scenario

```
Add Job → benchy-small.stl → Printer 02 (P1S, idle) → Slice → payload check (G-code + numbers only)
→ appears in the queue → mock progress starts → the card's layer count climbs → toolpath shown
```

The boundary scenario:

```text
register a job on Printer 04 (offline) → stays queued → toggled online → printing starts → completed
→ no model bytes in the payload, and farm_store.js's import list is empty
```

## To add to the docs after implementation

- deployment URL and screenshot
- the store ↔ HTTP contract table (the swap points when a backend is attached)
- how to run the tests with a fast mock clock (`createFarm({ tickMs })`)

## Production considerations

A real service needs the backend — two operators must see the same queue, jobs must survive a refresh, and
printer adapters (Moonraker/OctoPrint/Bambu), permissions, retries and file-retention policy attach to it.
What this demo shows is **how thin that backend is allowed to be**: queue, state and file storage — no
slicer. Move `farm_store.js` to a server as-is and it becomes that server.
