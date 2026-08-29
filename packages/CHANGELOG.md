# Changelog

## 0.2.3 — 2026-08-29

A developer-experience release: everything here comes from a log of what integrating the package actually
cost while building the four `examples/` demos and the live landing embed (`packages/FRICTION.md`). The
theme is the one failure mode they shared — wrong input returning something plausible instead of an error.

### Added

- `sliceRequest` on `<Viewport/>`: a token whose identity change requests one slice. The component's
  contract stays props-only, but a host that hides the built-in chrome no longer has to remount the whole
  viewer to start a slice (which blanked the scene and re-parsed the model — measured as a visible
  double-flip on the landing embed).
- `result.warnings`, a `string[]` naming what a **successful** slice got away with. Today's one entry is
  `'over_bed_model'`: a bed-centred model sliced outside the printable area with plausible time and
  material and no error. Present on the direct handle, through `createSlicerClient()`, and on the raw
  worker's `done` reply. The `stats` flags are unchanged.
- `result.throughput` — how fast the slice ran: `ms` (wall time around the call), `kernelMs` (the kernel's own
  phase total, so `ms - kernelMs` is the WASM boundary cost), `layersPerSecond`, and `msPerMsegment`. The last
  one is the field to compare runs with: the kernel is not deterministic in segment count, so raw milliseconds
  compare two different amounts of work. Same three paths as `warnings`, and on the SLA routes as well —
  `kernelMs` there sums the resin passes (contours, sample, tree, raster, emit), since the two technologies
  share only the name `t_emit_ms`.
- Throughput in the viewer, in three places: the slice bar shows layers/second **while** a slice runs, the stats
  card shows the finished figure ("Sliced in 4.0s · 166 layers/s", with the kernel share and ms/Msegment on the
  tooltip), and hosts receive both — `sliceRate` on `onEvent` and `throughput` beside `stats` on `onSliced`.
  An SLA slice reports the live figure throughout; an FFF slice reports it once the emission pass starts
  streaming layers, since its earlier passes publish no per-layer progress and none is invented. It therefore
  reads higher than the whole-slice average, which counts the passes that emit nothing (measured on a 38MB
  model: 306–707 layers/s live, 166 over the whole 4.0s slice).
- `applyPreset(settings, preset, keys)` in `three-slicer/settings` — clear-then-merge, so a preset switch
  cannot leave the previous material's keys underneath. All four demos had written this by hand.
- `kernelSettingKeys` and `ignoredKernelSettings(settings)`: the 128 schema keys the FFF derivation reads,
  and which of yours it does not. A key it does not read is accepted and does nothing.
- The raw worker's slice request accepts an object `params`, not only a JSON string — the direct handle
  and the client already did, and the worker's own SLA branch always had.

### Fixed

- The prime tower stand-in is drawn only when the plate actually changes tools — objects on more than one
  extruder, or material paint reaching extruder 2 or higher — instead of whenever a second filament happened to
  be loaded. With everything on T1 the slice emits no tool change and generates no tower, so the box promised
  one that would not be printed.
- The viewer no longer shows a slice result that the current settings would not produce. A change to `settings`
  drops the cached results and returns to Prepare, instead of leaving a preview, a print estimate and an enabled
  G-code export describing the settings the slice ran with. An injected (`gcode` / `sl1`) plate and an opened
  `.sl1` archive are left alone — neither claims to be a slice of these settings.
- **`createSlicerClient()` with no argument now works after `vite build`.** Its default worker is written
  as the literal `new Worker(new URL(…), { type: 'module' })` that bundlers recognize as a worker entry;
  routed through `engineWorkerURL()` it matched Vite's plain-asset rule instead and was copied verbatim,
  still importing an unhashed `./slicer_core.js` that the build never emitted — a 404 on the first message,
  invisible until a production build. Measured on a Vite 5 consumer: a 21KB copy in a 40KB dist with no
  kernel at all, versus a 12KB worker chunk importing the emitted kernels. `pack_check.sh` now fails when
  a worker chunk imports a file the build did not produce.
- `support_type: 'tree(auto)'` selects tree supports. Tree vs grid was routed from `support_style` alone,
  so an imported OrcaSlicer project asking for tree supports sliced grid, silently.
- A `files` prop changed after mount warns once instead of being ignored in silence.

### Changed

- `engineWorkerURL()` is documented as the **no-bundler** path (native ESM, an import map, a CDN). Under
  Vite or webpack use `createSlicerClient()` or `three-slicer/worker?worker`. The function is unchanged.
- Since tree vs grid now reads `support_type`, a settings map carrying `support_type: 'tree(auto)'` with
  `support_style: 'default'` produces different G-code than it did in 0.2.2 — tree, as upstream does.

## 0.2.2 — 2026-08-22

### Added

- SL1 import in the viewer: an `.sl1` archive opens through the file picker, drag & drop, or the new `files`
  prop — rendered as a raster preview, with the model shape reconstructed from the masks in the background
  (two passes: a coarse mesh in under a second, then full resolution). This viewer's own exports carry scene
  and role sidecars, so reopening one shows the exported surface itself, in the sliced preview's colours, and
  re-exports byte-identical. Opening an `.sl1` applies the archive's job description to the settings
  (`printer_technology` first), so a fresh FFF session switches to the SLA route.
- SL1 export: role/scene sidecar members, off-thread mask encoding, and a save window.
- Move scrub in Preview: a horizontal slider that walks the top layer move by move with a screen-fixed nozzle
  marker — upstream's sequential view. Position changes reach the host as the `moveScrub` event.
- `files` and `sl1` Viewport props: models, `.3mf` projects, `.sl1` archives and preset files handed in once
  at mount.

### Fixed

- The SLA print area is the resin display size, not `printable_area`.

## 0.2.1 — 2026-08-21

### Added

- `pad_around_object` (embed) is now supported in the SLA path — the `SLA_PAD_AROUND_OBJECT_UNSUPPORTED`
  capability gate is gone. It forces zero elevation (upstream `is_zero_elevation`), and an empty embed pad is
  legal: the ring survives only where supports stand.

### Performance

- SLA slicing: the raster fallback was rewritten, and slicing/prepare run layer-parallel on the multithreaded
  kernel — byte-identical output, with progress bands matched to measured time.

## 0.2.0 — 2026-08-19

SLA (resin) printing lands as a second technology in the same kernel, routed by `printer_technology`.

### Added

- SLA slicing in the WASM kernel: `slicer.sliceSla(stl, params)` on the engine handle,
  `client.sliceSla` / `client.sliceSlaJob` on the worker client. Results carry per-layer mask segment
  streams, generated support and pad meshes, `resin_ml` / `time_estimate` stats and `lift_layers`
  (pad + elevation) — no G-code.
- The support chain is PrusaSlicer 2.9.6's own, ported verbatim: support-point generator
  (SupportPointGenerator + SupportIslands), the default support tree, and the real pad geometry. Built
  against vendored NLopt 2.5.0, Prusa's bundled libigl, SGI glu-libtess, and CGAL headers.
- `deriveSlaParams(settings)`, `printerTechnology(settings)`, `resinCatalog` / `resinSettingsFor(name)`
  in `three-slicer/settings`; SLA machine profiles and the resin material catalog in the data files.
- Typed capability errors instead of silent approximation: `SLA_UNSUPPORTED_HOLLOWING` (hollowing/drain
  holes), `SLA_UNSUPPORTED_ORGANIC` (organic trees), `SLA_PAD_AROUND_OBJECT_UNSUPPORTED` (zero-elevation
  pad embedding). `SLA_CAPABILITIES` from `three-slicer/client` is the machine-readable map.
- Viewer: an SLA printer profile swaps the filament card for the resin card, previews the support/pad
  meshes with the lifted layer frame, and exports `.sl1` archives — portrait PNG masks (the SL1 family's
  panel mounting) plus upstream's `config.ini` field set.
- `<SettingsPanel/>` renders the SLA tabs for an SLA profile — no prop, it follows the settings map.
- `.3mf` SLA records (manual support points, drain holes) survive import/export round-trip.
- A runnable SLA example: `node node_modules/three-slicer/engine/examples/sla_headless.mjs`.
- `THIRD-PARTY-NOTICES.md` documenting the licenses compiled into the shipped kernels.

### Notes

- The multithreaded kernel carries the SLA path too and is pinned byte-identical to the single-threaded
  one over the same SLA slice.
- FFF output is unchanged: the golden byte-identical G-code check holds across this release.

Earlier releases (0.1.x) predate this changelog.
