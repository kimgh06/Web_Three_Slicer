# Changelog

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
