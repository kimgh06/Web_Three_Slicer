# Printer Showcase — three-slicer demo

An embed demo that puts a slicer inside a printer manufacturer's product page. A fictional "ACME 3D"
landing page is the host, and one section inside it is three-slicer.

The integration is one file, [`src/slicer_section.jsx`](./src/slicer_section.jsx). It carries its own
machine list, settings state and styles, so it mounts into an existing site with one line.

```jsx
import SlicerSection from './slicer_section.jsx'

<section id="try">
  <h2>Try it with your model</h2>
  <SlicerSection />        {/* this is everything */}
</section>
```

The inside looks like this:

```jsx
// The host owns settings, and the machine buttons swap that state.
const [settings, setSettings] = useState(() => printerSettings(MACHINES[1].profile))

<div className="ts-frame">      {/* position: relative + a real height, required */}
  <Viewport
    settings={settings} setSettings={setSettings}
    defaultAutoSlice                                   // slices on its own once a model lands
    onEvent={e => e.type === 'progress' && setProgress(e.value)}
    onSliced={({ stats }) => setStats(stats)}          // the host page draws the statistics
    panels={{ topBar: false, printerCard: false, processCard: false, /* … */ }}
    features={{ shortcuts: false, logs: false }}       // the page's keyboard belongs to the host
  />
</div>
```

## Current status

It works. No deployment URL yet (`npm run build` → `dist/`, static hosting works).

Measured (M-series Mac, Chrome, 20mm cube):

| Machine | Bed | 0.20mm | 0.28mm |
| --- | --- | --- | --- |
| ACME A1 mini (`Bambu Lab A1 mini 0.4 nozzle`) | 180 × 180 × 180 | 15m · 4.0 g | 12m · 4.0 g |
| ACME P1 (`Bambu Lab P1S 0.4 nozzle`) | 256 × 256 × 250 | 12m · 4.0 g | — |

Same model, same material, different time per machine — because the profiles' motion limits actually
apply; raising the layer height cuts only the time, the material stays put.

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

Put a model on with **Choose file** or by dragging onto the plate and it slices automatically. With no
model at hand, download the 20mm test cube at the bottom of the page.

## Package APIs used

| Path | What is used |
| --- | --- |
| `three-slicer/viewer` | `<Viewport/>` — `settings`/`setSettings`, `defaultAutoSlice`, `panels`, `features`, `onEvent`, `onSliced` |
| `three-slicer/settings` | `printerSettings`, `printerDefaultPreset`, `processPresets`, `filamentPresets`, `settingScalar` |

`three-slicer/client` is not used — Viewport owns the worker and the slice lifecycle, and the host only
receives state through `onEvent`/`onSliced`. `three-slicer/components` is not used either:
`<SettingsPanel/>`'s `only` narrows only to **builder/page granularity** and has no arbitrary key-list
filter, so it does not fit "just layer height and infill". The host builds those two controls itself and
writes into `settings`.

## Architecture

```
host page (the ACME landing)
  └─ <SlicerSection/>
       ├─ 3 machine buttons → printerSettings(profile) + default process + compatible filament merged → settings
       ├─ <Viewport settings setSettings defaultAutoSlice …/>   ← worker, kernel, scene all owned by the viewer
       │     onEvent   → progress / slicing / error
       │     onSliced  → stats (time_estimate, filament_mm)
       └─ 2 host controls (layer_height, sparse_infill_density) → settings → automatic re-slice
```

## Run locally

```bash
npm i
npm run dev
npm run build && npm run preview   # confirm the build output behaves identically
```

## Important files

| File | Role |
| --- | --- |
| [`src/slicer_section.jsx`](./src/slicer_section.jsx) | **The whole embed.** Machine list, preset merging, Viewport, host controls, its own CSS |
| [`src/main.jsx`](./src/main.jsx) | The fictional product page. Marketing chrome unrelated to the integration |
| [`src/host.css`](./src/host.css) | Page styles + **deliberately hostile global CSS** |
| [`vite.config.js`](./vite.config.js) | ES workers, es2022 |

## Shadow DOM isolation verification

The top of `host.css` deliberately carries the indiscriminate selectors common on real sites:

```css
button { border-radius: 0 !important; text-transform: uppercase; }
canvas { max-width: 300px !important; filter: sepia(1); }
input, select { font-size: 24px !important; border: 4px dashed magenta !important; }
aside { display: none !important; }
```

Computed values measured in the browser:

| | Inside the frame (Shadow DOM) | Outside the frame (host DOM) |
| --- | --- | --- |
| `canvas` max-width | `none` | — |
| `canvas` filter | `none` | — |
| `button` border-radius | `8px` | `0px` |
| `button` text-transform | `none` | `uppercase` |
| `select` border | default | `dashed magenta`, 24px |

That is: the viewer is entirely unaffected by host CSS, while the parts this component draws into the host
DOM are affected. That boundary is stated in one line on screen too — a fact being demonstrated, not a
defect of the demo.

## Known limitation: automatic sample-model load

`<Viewport/>` has **no prop for the host to inject model bytes** (as of 0.1.7, and the local source at the
time matched). So "the sample is already on the plate when the page opens" cannot be built from the public
API alone. Rather than working around it with private scene access or a synthetic drop event, the demo
uses a test-cube download link plus the viewer's own file picker/drop.

Doing it properly needs a model-input path in the package (e.g. `<Viewport model={{name, buffer}}/>` or an
imperative handle arriving via `onReady`). Until then this demo's "automatic sample model load" completion
criterion is unmet.

## What is intentionally mocked

- ACME 3D is a fictional company. Buy now, the navigation and the spec table are inert marketing chrome.
- Real machine connection, firmware, cloud, accounts — none.

## Production considerations

- **CSP**: workers and WASM are used, so `worker-src blob:` and `script-src 'wasm-unsafe-eval'` are needed.
- **Bundle size**: the kernel WASM is in the 4MB range. On a product page, `features={{ warmup: false }}`
  and letting the download start when the user adds a model is kinder to first load.
- **COOP/COEP** switches to the multithreaded kernel and speeds up large models, but third-party embeds on
  the same page (ads, YouTube and the like) break without CORP headers. Marketing pages usually cannot
  turn it on.
- The per-machine profiles use `three-slicer/settings`' vendor data as-is. For your own machines, put your
  own profile in place of `printerSettings()` — the rest of the wiring stays.
