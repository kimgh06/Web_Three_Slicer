# three-slicer/viewer

3D slicer viewer as a React component: three.js viewport (orbit/transform gizmos), model import (STL/OBJ/3MF/AMF/PLY + pluggable formats such as STEP, multi-object, drag & drop), Web Worker slicing via `three-slicer`, support and material painting, per-extruder filament presets, multi-plate, and a GPU-instanced volumetric toolpath preview ported from OrcaSlicer's libvgcode (millions of segments in a single draw path, per-feature colors, layer range slider, G-code export).

![The Prepare tab — drag-and-drop viewport with the printer, filament and process cards in the right sidebar](../../slice-sidebar.png)

```bash
npm i three-slicer react react-dom three     # the three are optional peers; the viewer needs all of them
```

```jsx
import { useState } from 'react'
import Viewport from 'three-slicer/viewer'

function App() {
  const [settings, setSettings] = useState({})   // OrcaSlicer schema keys; sparse — defaults fill the rest
  // The container matters — see Layout below.
  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <Viewport settings={settings} setSettings={setSettings} />
    </div>
  )
}
```

Styles are injected into the component's Shadow DOM root — nothing to import, and host CSS cannot collide.

## Layout

**Give it a positioned, sized container.** The shadow host is `display: contents`, so it contributes no box of its
own, and the shell inside is `position: absolute; inset: 0`. It therefore fills the nearest *positioned* ancestor —
`position: relative` (or absolute/fixed) with a real height. Drop it into a plain static `<div>` and it escapes to
the initial containing block instead, which usually looks like the viewer covering the whole page.

There is no width or height prop: the component always fills that container, and resizes with it.

Slice parameters are derived from `settings` via `three-slicer`'s schema mapping — pair it with `three-slicer/components`' `<SettingsPanel/>` sharing the same state for a full slicer UI.

A `.3mf` written by a slicer (OrcaSlicer/BambuStudio save, MakerWorld download) imports as a **project**: plate layout, project settings, and support/material painting are restored, not just the meshes. Where a facet carries both paint kinds, material paint wins and the dropped support paint is reported.

Props: `settings`, `setSettings`, and three optional React-node slots rendered in the right sidebar —
`processPanel` (the process card), `motionPanel` (folded into the printer card) and `filamentPanel`
(folded into the filament card, next to the material picker).

Subpath exports for custom UIs (framework-free, no React):
- `three-slicer/viewer/toolpath` — GPU toolpath renderer (`buildSegmentData`, `makeToolpath`, view-type colorers)
- `three-slicer/viewer/loaders` — model loaders returning unified triangle soup
- `three-slicer/viewer/gcode` — `parseGcode(text)`, G-code back into the layer stream the renderer consumes

## Embedding it without the panels

Every panel can be switched off, and the values the component owns can be seeded and watched, so the same
`<Viewport/>` also works as a bare G-code viewer or as a headless slicer inside another app's UI.

```jsx
// A G-code viewer: no kernel run, no panels.
<Viewport gcode={text} panels={{ sidebar: false, topBar: false, gizmoRail: false, plateBar: false }} />

// A headless slicer: the host drives it and takes the result.
<Viewport panels={{ sidebar: false }} defaultAutoSlice onSliced={({ stats, gcode }) => save(gcode)} />
```

- **`panels`** — `{name: false}` hides one. Everything is visible by default, so a host only ever opts out and a
  panel added in a later version does not vanish for hosts that listed the ones they wanted. `sidebar: false` drops
  the whole right column; the rest are `topBar`, `gizmoRail`, `objectToolbar`, `paintPanel`, `statsCard`, `plateBar`,
  `emptyHint`, `status`, `printerCard`, `filamentCard`, `resinCard`, `objectList`, `previewControls`, `processCard`,
  `sliceBar`, `moveBar`. Which of `filamentCard`/`resinCard` renders follows the printer profile's technology: a profile whose
  `printer_technology` says SLA swaps the filament card (and the prime tower, and the painting brushes) for the
  resin card, and slicing routes to the kernel's `slice_sla` — PrusaSlicer's ported support/pad chain — with an
  `.sl1` export instead of G-code (portrait masks, like every SL1-family machine). The preview lifts the model by
  `stats.lift_layers` (pad + elevation), and a request the port does not cover (hollowing, organic trees)
  surfaces as a typed error instead of a wrong print.
- **`gcode`** — G-code text drawn on the selected plate instead of a slice result. `parseGcode` recovers roles from
  `;TYPE:` (OrcaSlicer/PrusaSlicer/Cura), from `;_EXTRUSION_ROLE:` tags and from this kernel's own feature comments;
  bead width comes from `;WIDTH:` or, absent that, from E. What the file never states cannot be recovered: an
  unmarked run reads as wall, and there is no print-time estimate (that needs the machine's acceleration limits).
- **The move scrub** (`panels.moveBar`) — the horizontal counterpart of the layer slider, under the canvas in
  Preview: the vertical one picks WHICH layers are shown, this one walks inside the top one. It is upstream's
  sequential view (`GCodeViewer`'s `update_sequential_view_current`) in this viewer's terms. On an FFF result it
  cuts that layer at a move — extrusions and travels together, in the order the printer performs them, which the
  two draw lists do not store and `moveCursor` recovers — and marks where the nozzle is: a solid cone at the
  current position and a translucent one where the layer ends. Both are fixed SCREEN size and drawn over
  everything, because a marker that scales with the scene is a speck zoomed out and a marker that respects depth
  is buried in the bead it is pointing at. Position changes reach the host as the `moveScrub` event.
  FFF only, and deliberately: mSLA cures a whole layer in one exposure, so a resin layer has no intra-layer
  order to walk — the same conclusion upstream reaches, PrusaSlicer's SLA preview having a layer slider and no
  horizontal one.
- **`defaultExtruderColors`**, **`defaultAutoSlice`** — initial values for state the component owns. Unlike the
  in-app toggle, `defaultAutoSlice` also performs the *first* slice, which is what makes a panel-less embed able to
  slice at all.
- **`onEvent`** — one channel for every change: `canvasMode`, `objects`, `selectedPlate`, `plateCount`,
  `extruderColors`, `autoSlice`, `slicing`, `progress`, `viewType`, `paintMode`, `layerCount`, `layerRange`,
  `error`, `notice`. Initial values are not announced — the host passed them. `progress` fires several times a
  second while slicing.
- **`onSliced`** — `{plate, stats, gcode}` when a slice is cached. Switching plate tabs does not re-fire it.

## Keyboard and mouse

Which keys are live depends on the tab, and every one is ignored while an input has focus. Letter shortcuts match
the **physical** key, so they keep working under a non-Latin keyboard layout — with an IME on, the Korean layout
reports `'ㅁ'` for M, and matching on the character would silently kill every letter shortcut while leaving the
arrows and Delete working.

| Both tabs | |
| --- | --- |
| `Ctrl/⌘ + R` | Slice the current plate |
| `Ctrl/⌘ + C` / `V` / `X` | Copy · paste · cut the selection |
| `Ctrl/⌘ + K` or `Ctrl/⌘ + D` | Duplicate |
| `Ctrl/⌘ + A` | Select all |
| `Ctrl/⌘ + Z` | Undo — bound to the component root, so it never reaches your app's own Ctrl+Z |
| `Ctrl/⌘ + Shift + Z` or `Ctrl/⌘ + Y` | Redo |

| Prepare | |
| --- | --- |
| `M` or `G` · `R` · `S` | Move · rotate · scale gizmo |
| `Arrow keys` | Nudge 10mm — `Shift` for 1mm |
| `PageUp` / `PageDown` | Rotate ±45° |
| `Delete` / `Backspace` | Remove the selection |
| `Z` · `B` | Zoom to all · zoom to bed |
| `Esc` | Cancel the current tool |
| `?` | Shortcut help overlay |

| Preview | |
| --- | --- |
| `↑` / `↓` | Step one layer — `Shift` for ten |
| `L` · `T` | Single-layer view · travel moves |
| `Z` · `B` | Zoom to all · zoom to bed |
| `Esc` | Back to Prepare |

Mouse selection follows upstream's rules: a plain click **replaces** the selection, `Ctrl/⌘ + click` adds or
removes, a plain click on something already selected **keeps** the set (which is what makes dragging several
objects work), `Shift + drag` is a box select, and clicking empty space clears. Alt is not a de-select, in
upstream or here.

## Undo and redo

The history covers the viewport's **own** state: object transforms, additions, removals, per-object extruder and
visibility. Fifty steps, with repeats of the same action inside half a second folded into one — so a held arrow key
undoes as a single move rather than forty.

What it deliberately does not cover, and why the boundary sits there: `settings` is **yours**, passed in as a prop,
so nothing inside the component can put it back. Painting is outside it too (restoring a step would need a kernel
re-`prepare` for every entry), as are the prime tower and the plate count, which write host settings. If you want
those undoable, undo them on your side of the prop.

## Materials and painting

The filament card holds **one material per extruder**: add an extruder, pick its colour, and pick its filament preset from the vendor catalog (`filamentPresets()` in `three-slicer/settings` — the shortlist is the printer model's own recommendation, the full list everything compatible). Selecting a row aims the material picker and the settings form at that extruder; the colours feed the object meshes, the prime tower and the preview's **Filament** view type, which colours every segment by the extruder that printed it.

The brush has two targets sharing one shell: **support painting** (enforcer / blocker) and **material painting** (one chip per extruder, plus an eraser that returns facets to the default extruder). They are mutually exclusive, and that is a data constraint rather than a UI choice — upstream's `EnforcerBlockerType` is a single enum in which ENFORCER *is* Extruder1 and BLOCKER *is* Extruder2, so one integer per facet means a support mark and a material mark cannot coexist there.

Two limits to expect while using it:

- Painting a region onto a second extruder only takes effect with **support turned off**. The painted multi-material path emits no support, so a support-enabled slice deliberately stays on the single-material path (where painted support keeps working as before).
- On a machine with two or more extruders, a support *blocker* paint and an *Extruder 2* paint are the same mark and cannot be told apart.

If you consume `three-slicer/viewer/toolpath` directly, note that the stride-8 role field `paths[k+3]` now carries the printing extruder alongside the role as `role + tool * 16`. Mask it — `& 15` for the role, `>>> 4` for the tool. Streams produced before this encoding are entirely below 16 and decode to their own role with tool 0, so older data still reads correctly.

## Turning behaviour off

`panels` controls what is drawn; `features` controls what the component *does* outside its own box. Same rule —
opt-out only, everything on unless you say `false`, an unknown key stays on.

```jsx
<Viewport
  gcode={text}
  panels={{ sidebar: false, topBar: false }}
  features={{ warmup: false, shortcuts: false, logs: false }}
/>
```

| Key | Off means |
| --- | --- |
| `shortcuts` | No keyboard bindings. They are installed on `window`, so while the viewer is mounted they fire wherever focus is (inputs excepted) — and `Ctrl+C` preventDefaults, which takes a host page's own copy. Turn them off when your app has its own. |
| `warmup` | The WASM kernel is not loaded on mount. Nothing is downloaded or compiled until something actually slices — which for a `gcode`-only viewer is never, so this is several megabytes and a thread pool you stop paying for. |
| `drop` | No drag and drop onto the canvas. |
| `filePicker` | The file dialog never opens, from any of the buttons that open it. |
| `contextMenu` | No right-click menu. The browser's own menu stays suppressed over the canvas either way — OrbitControls preventDefaults `contextmenu` itself. |
| `logs` | No console output, from the component or from the slice worker. |

### Read-only panels

A sidebar panel can also be shown but not editable — the shape you want when the host picks the printer, process
and filament itself and does not want the user changing them. It is a third value on the same `panels` key:

```jsx
<Viewport
  settings={presetSettings}
  panels={{ printerCard: 'readonly', filamentCard: 'readonly', processCard: 'readonly' }}
/>
```

Lockable: `sidebar`, `printerCard`, `filamentCard`, `objectList`, `towerCard`, `previewControls`, `processCard`,
`sliceBar`. `sidebar: 'readonly'` locks the whole column at once; the per-card keys are for mixing, such as a
locked printer card above a live object list. Every other panel takes `true`/`false` only — a `'readonly'` that
silently did nothing on half the keys would be worse than not offering it.

The panel is drawn normally and keeps showing real values; it just cannot be clicked, typed into or tabbed to, and
that includes any node you passed into it (`motionPanel`, `filamentPanel`, `processPanel`). Implemented with the
`inert` attribute, so it needs Chrome 102+, Safari 15.5+ or Firefox 112+.

**It locks the UI path, not the value.** `settings` is still your prop, and other paths inside the viewer still
write it — importing a 3mf project applies that project's settings whether or not the cards are locked.

### Printer preset files

The printer card carries **Load** and **Save**. Save writes an OrcaSlicer preset: a machine `.json` on its own, or
an `.orca_printer` bundle when the settings map also names a process or filament preset (the cards record those as
`printer_settings_id` / `print_settings_id` / `filament_settings_id`, so nothing extra has to be tracked). Load
accepts the same set upstream's dialog does — `.json`, `.orca_printer`, `.orca_bundle`, `.orca_filament`, `.zip` —
and applies every preset it finds, clearing that type's keys first.

`inherits` is followed through the shipped printer catalog, so a vendor file loads with its bed intact; when the
parent is unknown the file's own values are still applied and the notice says so. Codec details and the reason
that matters are in the [package README](../README.md#preset-files).

Load opens a file dialog, so it respects `features.filePicker`; Save goes through `onExport` like every other
download.

### Taking the saves

The save buttons are inside the component, so `onExport` is the only way to send a file somewhere other than the
browser's download folder. It sees the 3mf project, the STL and each plate's G-code. Return truthy to say you
handled it:

```jsx
<Viewport onExport={(file, filename) => { uploadToServer(file, filename); return true }} />
```

Return nothing and the download happens as well, which is useful for logging what was saved without changing it.

## What the host cannot drive

The component owns its scene, and the props are the whole interface — there is no ref, no imperative handle, and no
`models` prop. Worth knowing before you design around it:

- **Models enter through the UI only** — the file dialog or drag and drop. A host cannot hand a mesh in, and cannot
  remove or transform one. What it *can* do is watch: the `objects` event reports `{id, name, extruder, visible}`
  for every object as the set changes.
- **Slicing is triggered from the UI or by `defaultAutoSlice`**, which unlike the in-app toggle also performs the
  first slice — that is what makes a panel-less embed able to slice at all. The result arrives on `onSliced`.
- **`gcode` is one-way**: pass G-code text and it is drawn on the selected plate instead of a slice result, and
  auto re-slice leaves that plate alone while it is set.
- Everything else the component owns — camera, selection, plate count, paint state — is reported through `onEvent`
  and settable only by the user.

If you need programmatic control over the scene, build on the subpath exports (`three-slicer/viewer/toolpath`,
`/loaders`, `/gcode`) and `three-slicer/client` rather than on `<Viewport/>`.

## Multithreaded slicing (automatic)

The engine ships two WASM kernels: single-threaded (default) and `-pthread` multithreaded (~2× wall-clock on layer-parallel wall generation, measured 12× on the wall pass itself). The worker picks the mt kernel automatically when the page is [cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) — i.e. served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

No headers → falls back to the single-threaded kernel. Nothing else to change.

## Bundler notes

- **Vite:** two config lines (worker code-splitting + top-level await in the mt glue; Chrome 89+/Safari 15+):

```js
// vite.config.js
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
```

- **Next.js / webpack:** render client-side (`dynamic(..., { ssr: false })`) and alias the emscripten glue's Node-only guards away:

```js
// next.config.js
module.exports = {
  webpack: (config) => {
    for (const m of ['node:module', 'node:fs', 'node:path', 'node:url', 'node:crypto', 'node:worker_threads'])
      config.resolve.alias[m] = false
    return config
  },
}
```

`three` is a peer dependency pinned to `^0.160` (TransformControls API; r169+ changed its Object3D contract).

## License

AGPL-3.0-or-later (derived from OrcaSlicer). A web app embedding this package must comply with AGPL — including offering its source to network users.
