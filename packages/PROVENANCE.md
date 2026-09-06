# Provenance

Which parts of this package are derived from upstream (OrcaSlicer / PrusaSlicer) and which are not — and
therefore what could carry a license other than AGPL-3.0-or-later.

The whole package ships AGPL-3.0-or-later today (`LICENSE.txt`). That is not in question here. This file
exists for one recurring question: **can any part of the viewer be published under a permissive license so
that industrial users can adopt it without the AGPL network-use obligation?** Answering it means knowing,
per file, whether the code is our own or a derivative of upstream — and that answer is expensive to
re-derive from scratch each time it comes up.

**This is a provenance map, not legal advice.** Anything acted on here should be reviewed by counsel. A
license change is also irreversible: a permissive grant, once published, cannot be withdrawn from the
versions already distributed.

## 1. The ceiling: the kernel can never be relicensed

| Location | Size | Origin |
| --- | --- | --- |
| `wasm-core/arachne_port/` | 114,001 lines C++ | OrcaSlicer, verbatim |
| `wasm-core/treesupport_port/` | 112,535 lines C++ | OrcaSlicer, verbatim |
| `wasm-core/slasupport_port/` | 19,145 lines C++ | PrusaSlicer 2.9.6, verbatim |
| `wasm-core/third_party/` | 381,842 lines C++ | vendored deps, own licenses (`THIRD-PARTY-NOTICES.md`) |

Copyright in those ports belongs to SoftFever / Prusa Research / the Slic3r authors. We hold no right to
relicense them, so:

- **Dual licensing is impossible.** Selling a commercial license requires owning the copyright. The
  Artifex/Ghostscript, iText, MinIO and Grafana model does not transfer to this project.
- The compiled kernels (`engine/src/slicer_core.js`, `slicer_core.mt.js`) are combined works of those
  sources and are AGPL. CGAL headers (GPL-3.0-or-later) compile in as well.
- The kernel bridge written here — `wasm-core` root sources, 11,709 lines (`bindings.cpp`, `params.cpp`,
  `emit.cpp`, …) — is our own copyright, but it links the ports and does nothing without them. Separating
  it is legally possible and practically pointless.

Anything that calls the kernel is a combined work and is AGPL when distributed. That includes slicing in
any form, so **a permissive "viewer with slicing" cannot exist.** What can exist is a viewer without it.

## 2. `packages/viewer` — derived files

Four files, 536 lines — 5.2% of the viewer's 10,370 JS/JSX/CSS lines (measured 2026-09-05; the viewer is
under active development, so re-measure before quoting). Each is flagged as a port by its own header
comment; the quoted text below is from the file itself.

| File | Lines | Self-description |
| --- | --- | --- |
| `src/core/toolpath_shaders.js` | 135 | "faithful port of the upstream `Segments_Vertex_Shader_ES`" |
| `src/core/toolpath_segments.js` | 203 | "faithful port of the upstream libvgcode toolpath renderer"; "the vertex shader is a straight port of the upstream ES variant (algorithm unchanged)" |
| `src/scene/toolpath_mesh.js` | 142 | "`SegmentTemplate.cpp:18` VERTEX_DATA (the 24 triangle indices of the 8-vertex diamond, **verbatim**)" |
| `src/core/toolpath_palette.js` | 56 | `DEFAULT_RANGES_COLORS` from `ColorRange.hpp:14`, and `ColorRange::get_color_at`'s interpolation |

These are the toolpath renderer, one contiguous concern. They are also the most commercially valuable part
of the viewer, so the 5.2% figure understates the difficulty of replacing them.

Grey areas inside this set, noted so they are not re-litigated: the 24-index diamond table is close to a
geometric fact, and the 11-colour heatmap is arguably a creative selection. Both sit inside files already
classified as derived, so nothing turns on resolving them.

`src/core/bed_grid.js` carries upstream `Bed_2D`'s spacing ladder as bare numbers. Functional values, and
trivially re-derivable, but they were taken from upstream — flagged rather than classified.

## 3. `packages/viewer` — `gcode_parse.js` is independently authored

`src/core/gcode_parse.js` (170 lines) was checked against upstream directly. It is not a port:

- **Structure.** Upstream `GCodeProcessor.cpp` is 7,561 lines plus a 1,530-line header: a state machine with
  per-axis acceleration/jerk time estimation, custom G-code blocks and an arc interpolation class. This file
  is a single line loop and deliberately derives no time estimate ("an estimate needs the machine's
  acceleration limits, which G-code does not carry"). The smaller `GCodeReader.cpp` (358 lines) is a
  callback-based parser class and is a different shape again.
- **The one formula.** `w = A/h + h·(1 − π/4)` is the algebraic inverse of upstream's rounded-rectangle bead
  cross-section (`Flow.cpp:225`, `m_height * (m_width - m_height * (1. - 0.25 * PI))`). A mathematical
  relation, written out here as its inverse.
- **The remaining upstream contact is file-format data**: the `;TYPE:` strings Orca/Prusa/Cura emit, and
  `GCodeExtrusionRole` enum numbers. Values needed to read someone else's output.
- **History.** Two commits, the first being `feat(viewer): parse G-code back into the renderer's layer
  stream`. Written here.

It has zero imports, so it is separable as-is. On its own it only parses; drawing the result needs §2.

## 4. `packages/viewer` — everything else

299 upstream references across 57 files were reviewed. Excluding §2 and §3 they fall into two groups,
neither of which is derivation:

**Interface and file-format facts.** Values required to read and write someone else's files:
`parse_3mf.js` / `write_3mf.js` (3mf member paths, the `paint_color` triangle attribute, 1-based
`plater_id`, `Slic3r_PE_sla_*.txt` record formats), `sl1_read.js` / `sl1_write.js` / `png_gray.js`
(`config.ini` field set, the `expUserProfile` enum, mask filename ordering, the gray8 PNG layout upstream's
reader requires), `preset_bundle.js` / `preset_actions.js` (the `.orca_printer` archive layout),
`support_paint.js` (`EnforcerBlockerType` stopping at Extruder16), `plate_layout.js`
(`UPSTREAM_PLATE_GAP_RATIO = 1/5`, without which an imported project decodes to the wrong coordinates).

**Behaviour citations.** Comments explaining what upstream does and why this code agrees or differs, with
implementations that share no expression: `use_three_scene.js` (25 references), `Viewport.jsx` (21),
`paint_input.js`, `box_select.js`, `brush_cursor.js`, `section_plane.js`, `nozzle_marker.js`,
`shortcut_keymap.js`, `model_loaders.js` and the `ui/*.jsx` components. `box_select.js` documents a
deliberate divergence — upstream uses a GPU picking pass, this projects world bounding boxes to screen.

## 5. `packages/data` — cannot be relicensed

The extracted artifacts (`web/extract_all.py`, sourced from `slicers/slicer`) carry upstream's authored
text, not just structure. From `config-schema.json`, one of 976 entries:

```json
"layer_height": {
  "label": "Layer height",
  "tooltip": "This is the height for each layer. Smaller layer heights give greater accuracy but longer printing time.",
  "defined_in": "init_common_params", "line": 918
}
```

Every key carries upstream's label and tooltip prose, and records the upstream source location.
`ui-tree.json` likewise carries page and group names plus `Tab.cpp` line numbers. `printers.json`,
`processes.js` and `filaments.js` are extracted from the upstream vendor profile bundles.

The viewer's dependency on this is small, and inverting it is the natural boundary regardless of licensing:

| Consumer | Use |
| --- | --- |
| `viewer/src/core/support_settings.js` | `schema.support_style.enum_values` / `enum_labels` for one dropdown |
| `viewer/src/ui/FilamentCard.jsx` | `uiTree[builder]` to choose which filament options to show |

`packages/components`' `<SettingsPanel/>` is the heavy consumer and stays AGPL — it is a settings form, not
the viewer.

## 6. What a permissively licensed viewer would cost

| Work | Size |
| --- | --- |
| Rewrite the toolpath renderer without reference to upstream (§2) | 536 lines, 4 files |
| Invert `three-slicer/settings` — 10 import sites: 5 pure-utility moves (`settingRaw`, the 3mf and preset codecs, catalog lookups), 5 requiring props inversion (`deriveKernelParams` / `deriveSlaParams` / `printerTechnology` in `Viewport.jsx`, `use_slicer.js`, `plate_actions.js`, `model_load.js`, `ResinCard.jsx`) | structural |
| Invert `three-slicer/data` — 2 import sites (§5) | small |
| Package split, per-package `LICENSE`, and a boundary test that fails on a derived import | small |

Direction matters: the permissive package must not import the AGPL one. The AGPL package depending on the
permissive one is fine.

Two facts make this viable rather than cosmetic. The toolpath and G-code surfaces (`viewer/toolpath`,
`viewer/gcode`) already form a closed import island — none of them reaches the kernel. And
`viewer/src/use_injection.js` already renders `gcode` and `sl1` artifacts on a plate **without running the
kernel**, so a viewer without slicing has a real use case rather than being a shell built to route around a
license.

## 7. Method and limits

Classification is based on each file's own header comments, its import graph, and — for `gcode_parse.js` —
a structural comparison against upstream. A line-by-line diff against upstream's 7,561-line
`GCodeProcessor.cpp`, or against libvgcode, was **not** performed. This codebase's comments are unusually
explicit about what was ported, which is what made the audit tractable; a comment reading "upstream does the
same" could still sit above copied code.

Before any file is actually published under a different license, that specific file should be diffed
against upstream, and authorship of `packages/viewer` should be confirmed across all contributors — a
relicense needs every copyright holder's agreement.

## 8. Precedent

Consumer 3D printing runs almost entirely on this lineage: PrusaSlicer → BambuStudio → OrcaSlicer →
ElegooSlicer / Creality Print / Snapmaker Orca / Anycubic. Anycubic, Bambu Lab, Creality, Elegoo,
Flashforge, Snapmaker and Sovol all ship AGPL-derived slicers alongside commercial hardware and publish the
source; the revenue sits in the hardware and the ecosystem, not in the software license.

The cautionary case is the one attempt to keep a piece closed: BambuStudio's proprietary networking plugin,
loaded at runtime from a CDN, drew a public AGPL-violation accusation from Josef Prusa. Partial closure is
the pattern that draws challenge; full compliance is the pattern that does not.

For internal industrial deployment specifically, AGPL costs nothing: obligations attach to distribution, and
software used by employees of one legal entity is not conveyed to third parties. Note that this viewer ships
its code to every browser that loads the page, so "we only run it on our own server" is not the relevant
test — who opens the page is.
