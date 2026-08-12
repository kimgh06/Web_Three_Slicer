# AGENTS.md

Web_Three_Slicer — a browser/WASM slicer reverse-engineered from OrcaSlicer. The root holds three folders:

- **`slicers/`** — the upstream reference checkouts, untracked: OrcaSlicer at `slicers/slicer` (the extraction/porting source — its own guide is `slicers/slicer/AGENTS.md`) and PrusaSlicer at `slicers/PrusaSlicer` (comparison only).
- **`packages/`** — the published npm package `three-slicer` (a single one) plus the kernel sources. Zero build or runtime dependency on `slicers/`.
- **`web/`** — the demo app shell. It consumes the package as a workspace (no relative-path imports). Details: `web/README.md`, `web/GUIDE.md`, `web/SPECS.md`.

The root `package.json` is the npm workspaces root (`packages/*` + `web/viewer`) — a single `npm i` at the root installs everything.

## Core rules

- **Never modify `slicers/`.** All development happens in `packages/` and `web/`.
- `packages/` and `web/` must run, build and publish without `slicers/` (demonstrated in stage 34). Do not make changes that break this independence.
- Changes to the kernel (`packages/wasm-core/`) must pass the golden byte-identical check (`golden.mjs`) and the `test.mjs` invariant suite.
- Multi-material widened what "byte-identical" has to cover. Three conditions, each with its own `test.mjs` invariant, must keep producing the output the kernel produced before the feature existed: **no painted facets**, **no per-extruder arrays** (`extruder_nozzle_temp`, `extruder_flow_ratio`, `extruder_retract_*`, `extruder_z_hop`), **`support_filament` 0**. All three hold by omission rather than by a default: `deriveKernelParams` leaves those keys out of the params object entirely (89 keys from an empty settings map, 93 with two extruders and a support filament), and `Params::forTool` / `support_tool_of` fall back to the scalar and to "emit no `T` command at all".
- One material per extruder. Upstream stores every filament option as one entry per extruder, so the kernel takes per-extruder vectors and reads them **positionally** — a hole must be filled with the value tool 0 resolved to, because the kernel cannot tell "absent" from 0. On every `T` change `slice_multimaterial` reloads the whole loaded-filament set (diameter, flow, retraction length/speed, z-hop, and `M109` when the temperatures actually disagree).
- Support painting and material painting are **one** ported TriangleSelector, because upstream's `EnforcerBlockerType` is one enum: `ENFORCER`==Extruder1, `BLOCKER`==Extruder2, `Extruder3..16`==3..16. So a facet holds one integer, and a support BLOCKER paint is indistinguishable from an Extruder2 paint. `slice()` therefore routes a painted model to the multi-material path only when support is **off** (`slicer_core.cpp`) — `slice_multimaterial` emits no support at all, so routing a support-enabled slice there would silently drop it. Consequence to state plainly: **paint and support cannot currently produce two materials together.**
- Painted regions come from upstream's exact per-layer segmentation, `MultiMaterialSegmentation.cpp`, ported to `packages/wasm-core/treesupport_port/libslic3r/`. Everything above its driver is upstream verbatim; the driver was rewritten because upstream's takes a `PrintObject` (nothing in this kernel has one) — it now takes the sliced contour of every layer plus the selector's painted facets, through `selector_bridge::segment_prepare` / `segment_regions`. Two consequences: `slice_mm.cpp` must slice **every** layer up front (the segmentation is a whole-object pass, and it reuses those contours so nothing is sliced twice), and a painted flat face reaches the print only through `segmentation_top_and_bottom_layers` — a horizontal facet cuts no slicing plane, so that pass is not optional. Its Voronoi/EdgeGrid/MutablePolygon dependencies were already linked for Arachne; only the one new TU was added to `build.sh`.
- **One coordinate frame per plate.** The viewer hands the kernel plate-local coordinates (world minus the plate
  origin) and nothing else. It used to subtract the content's own bbox centre instead, so the slice frame moved
  whenever the model did and every bed-anchored thing needed its own correction — the prime tower drifted by the
  model's off-centre amount and a paint stroke after a drag landed where the model used to be. That centring was a
  workaround for `infill_lines` (`clip_util.h`), which drew each pattern line through the origin-projected foot and
  extended it by the region's own SIZE, so a region further from the origin than that got no infill and no error
  (measured on a 20mm cube: sparse 828 -> 414, solid 427 -> 183). Fixed by adding the region's distance from the
  origin to the reach; the `[position invariance]` invariant in `test.mjs` pins it at six placements.
- Painting is per facet, so a move must not cost it. `selector_reprepare` (bindings) rebuilds the selector on the
  moved coordinates — which the brush and the layer projection both need — and carries the marks across through
  upstream's own `TriangleSelector::serialize`/`deserialize`. It reports false and starts clean when the face count
  differs, because a different model's facet 7 is not this one's. The viewer decides which case it is from a
  TOPOLOGY key (`objectId:extruder:faces` per object), not from the vertex bytes: bytes change on every move.
- **A `.3mf` is a project, not a mesh format.** Anything off MakerWorld, and every OrcaSlicer/BambuStudio "save
  project", is a zip whose `3D/3dmodel.model` is only one member; `Metadata/project_settings.config` holds the
  flattened preset the author sliced with, `Metadata/model_settings.config` the per-object state and plate layout.
  `parse3MFProject` reads all of it (`parse3MF` stays the geometry-only shape). Two traps that do not look like
  traps: **(1)** every value in `project_settings.config` is a STRING — a bool is `"0"`/`"1"` — and `deriveKernelParams`
  reads bools with `!!v`, so importing raw turns every disabled option ON (`!!"0" === true`). Everything must go
  through `normalizeProjectSettings`, which coerces by config-schema type and drops non-schema keys. **(2)** The
  same trap again in a shape that does not look like one: a POINT is the string `"XxY"`, while every consumer
  indexes it as an `[x, y]` pair — so a raw `printable_area[1][0]` is the CHARACTER `'2'` of `"256x0"` and the bed
  comes out **2mm x NaN** (measured on a real MakerWorld project). `coPointsGroups` is a comma-separated LIST of
  such points in one string, and a few options (`best_object_pos`) use `,` where the rest use `x`. A `test_3mf_project.mjs`
  guard asserts every schema option type has a decided coercion, because points were missed exactly by nothing
  forcing that decision. **(3)** Painting is NOT in `model_settings.config` with the rest of the per-object state —
  it rides on the `<triangle>` tag itself as `paint_color` / `paint_supports` / `paint_seam` / `paint_fuzzy_skin`.
  Upstream's `inherits` / `different_settings_to_system` reconciliation (`Preset.cpp:2577`) is deliberately NOT
  reproduced: it exists to rebase a stored preset onto a LOCAL vendor preset database of a possibly different
  version, and this package has no such database — the flattened values are taken as written.
- A painted facet's 3mf value is its split TREE, not a state: upstream writes the same bitstream
  `TriangleSelector::serialize` produces, as hex, most-significant nibble first (so Extruder3 reads `"0C"`). The
  selector already had both halves of that codec; the only piece that had to be ported is the hex↔bitstream
  conversion, `FacetsAnnotation::get_triangle_as_string`/`set_triangle_from_string` (`Model.cpp:3542`), now
  `selector_bridge::apply_paint_hex`. Three things it forces on callers: `triangles_to_split` must be strictly
  ascending (the bridge sorts and de-duplicates, since a 3mf lists facets in its own order); the import REPLACES
  every mark because upstream's `deserialize` resets first, so it may only run on a freshly prepared selector; and
  a malformed hex string drops its whole facet rather than leaving a truncated bitstream, which the tree walker
  would read straight into the next facet's share. The reverse, `selector_bridge::export_paint_hex`, is the port of
  `get_triangle_as_string`, batched over one `serialize()` instead of upstream's per-facet binary search. It is what
  a "save project" needs and JS cannot substitute for: a brush stroke lives ONLY in the selector, and it is a split
  tree, not a facet list — one measured stroke on a 12-facet cube exports 2 source facets carrying 1168 painted
  sub-facets in a 1673-nibble string.
- **Writing a project is not the mirror image of reading one.** `write_3mf.js` re-encodes what the parser decodes,
  so each of the import traps has a matching one here: every value goes back out as a STRING through
  `serializeProjectSettings` (the inverse of `normalizeProjectSettings`, `settings.js`) — a raw JS `false` would be
  read back by anyone's parser as the string `"false"`, which is truthy; a point goes back to `"XxY"`; and the plate
  positions are re-encoded under UPSTREAM's grid (the constant is `UPSTREAM_PLATE_GAP_RATIO` in `plate_layout.js`,
  shared with the importer so the two cannot drift). Two asymmetries that are NOT bugs: the kernel's facet numbering
  is per merged mesh and a 3mf's is per object, so `write3MFProject` rebases with the same running offset
  `buildMergedSTL` used — which is why `exportObjects` must return objects in that same extruder-sorted order; and
  the kernel's marks are only taken when the whole project sits on ONE plate, because the selector only ever holds
  the merge of the selected plate and rebasing across plates would be a guess. Otherwise each object keeps the paint
  it was imported with, so opening a painted project and saving it again never strips it.
  `write3MFProject` is **async** because the deflate runs off-thread (fflate's worker pool, as the parser's `unzip`
  already does) — a save is dominated by compression, and on the main thread that is a frozen tab. Measured on a
  980k-facet model: 2.6s all-on-thread when this landed, 1.5s wall / 0.45s longest frame gap now. Two of that came
  from choices worth not undoing: the weld keys vertices by their float32 BIT PATTERN rather than a decimal string
  (708ms -> 89ms), and the zip is level **3**, which on this XML is both faster than level 6 and slightly smaller.
  The `[vp-prof] export` line reports gather/paint/write separately, because the three scale with different things.
- **An imported project's object positions are absolute, under UPSTREAM's plate grid — not this one's.** A
  slicer-written 3mf lays its plates out in world space, so an object's coordinates already say which plate it is
  on and where: upstream's origin is `(col*W*1.2, -row*D*1.2)` at the plate's **corner** with rows growing along
  **-y** (`PartPlate.cpp` `compute_shape_position` / `plate_stride_x`, `LOGICAL_PART_PLATE_GAP = 1/5`), while this
  viewer uses a constant 40mm gap and a plate origin at the **centre** (`plate_layout.js`). The two coincide at a
  200mm bed (`200*1.2 == 200+40`) and diverge everywhere else — 307.2 vs 296 on the 256mm bed a Bambu project
  uses. `platePlacements` (`model_load.js`) therefore decodes with upstream's rule and re-emits offsets for ours,
  falling back to per-plate group re-centring if any object fails to decode onto the plate it claims.
  Two things make this easy to get wrong and hard to see: `bakeLocal` centres every object's geometry and the
  placement cursor then puts it wherever it likes, so the file's position survives ONLY in the bbox the parser
  records; and the bed used to lay the plates out at import time must come from the project's own settings, not
  from the component's `kp` — `setSettings` has not landed yet, so `kp` still holds the 200mm default and the
  effect that re-lays the plates afterwards then slides the grid out from under everything just placed (measured:
  56mm per column, so plate 2 ended up 112mm off).
- 3mf facet indices are per OBJECT, the selector's are per MERGED MESH. The rebasing happens in `buildMergedSTL`
  (`use_three_scene.js`) and nowhere else — that function is what decides which objects are merged and in what
  order (visibility, plate, the extruder sort), so any other place would be guessing. It survives `bakeLocal` and
  the STL weld because both preserve triangle ORDER.
- One facet holds one integer (see the EnforcerBlockerType note above), but a 3mf keeps material and support paint
  in two independent annotations that can both mark the same facet. On import **material paint wins** and the
  support paint is reported as dropped — half-applying it would be worse than not applying it.
- The toolpath stream's role field (`paths[k+3]`, stride 8) encodes `role + tool * 16`. Roles only reach 11, so the tool rides in the spare high bits rather than a 9th float — the segment stream is the largest array the viewer holds and a 9th float costs +12.5% of it for one small integer. **Anything reading that field must mask** (`& 15` for the role, `>>> 4` for the tool); pre-encoding output is entirely below 16 and decodes to its own role with tool 0.
- `web/extract_all.py` derives the kernel key list by regex-scanning `packages/engine/src/settings.js` for single-quoted lowercase strings and keeping the ones that are schema keys — **it does not strip comments**. Measured: appending only the comment `// note: the 'interface_shells' option is not wired up yet` takes the list from 92 keys to 93 and adds that column to every extracted preset. Never write a schema key name in quotes in a comment in that file.
- **The transform gizmo is deliberately not the stock one.** Three edits to `TransformControls`, each measured, each
  easy to mistake for superstition and delete: (1) `showY` is false in **translate** mode only — a part prints off
  the bed, so up/down is not a move (it also takes the XY/YZ plane handles, leaving X/Z/XZ). Set per mode, and
  `seatMesh` still has to run on commit because rotate and scale move the lowest point. (2) The scale gizmo's `XYZ`
  handle is **removed from the object graph**, not hidden — the per-frame update rewrites `visible` and `scale` on
  every handle it owns, so flags do not stick; the bounding-box corners (`scale_box.js`) are the usable version of
  that grip. (3) A 16px dead zone around the gizmo origin in scale mode: a scale drag's ratio is
  distance-now/distance-at-press, and every axis picker reaches the origin, so a press there divides by ~0 — measured
  4e7 on a 20mm cube, and negative past the centre, which mirrors the mesh and inverts the winding the kernel slices.
  `clampMeshScale` bounds the result (0.2mm..5000mm, positive) for the drags that stay legal.
- **Corner handles must win the pointer where they overlap a gizmo axis** — they are drawn over everything, so they
  have to act there too. TransformControls picks its axis on HOVER and its listener is registered first, so it cannot
  be outrun in `onDown`; it is switched off while the pointer is on a handle instead (`updateHandleHover`).
- **Letter shortcuts match `e.code`, never `e.key`** (`shortcut_keymap.js`). Under a Korean layout `e.key` for the M
  key is `'ㅁ'`, so every letter shortcut died while the IME was on while the arrows and Delete kept working — which
  is what made it look intermittent rather than broken. `e.key` stays as a fallback for remapped Latin layouts.
- **Undo/redo covers the viewport's own state and stops there** (`history.js`). `settings`/`setSettings` are the
  HOST's props, so the boundary is drawn by the component's interface — painting, the prime tower and the plate
  count sit outside it too (paint restore needs a kernel `prepare` per step; the other two write host settings).
  Three things the design depends on: entries are **snapshots, not inverse operations** (geometry rides along by
  reference — `localPos` is immutable — so undo and redo become one function with the stacks swapped, and a new
  scene feature becomes undoable by calling `record()` and nothing else); `record()` runs **before** the mutation,
  and a drag records at its START (`onTransformStarted`) because the commit only fires once the mesh already holds
  the new pose; and restoring must redo a move's commit work (`registerSelector` + `checkBed`) or the paint overlay
  is left where the model used to be. `restoreScene` re-creates a deleted object **under its original id** — the id
  is half the paint topology key (`${id}:${ext}:${faces}`), so a fresh one silently drops that object's painting.
  Record at the ACTION layer, never on the buttons: delete alone is reachable from four entry points.
- UI components (viewer, components) are Shadow DOM isolated — each package's `styles.css` is inlined into the bundle via `?inline` and injected into the shadow root, so class names cannot collide with the host app's CSS.
- Licensed AGPL-3.0-or-later (`LICENSE.txt`).

## Commands

```bash
# Install (once, at the root) + build the packages (components/viewer dist)
npm i && npm run build

# Viewer demo app (uses the committed WASM — emscripten not required)
cd web/viewer && npm run dev

# Kernel tests (120+ invariants)
node packages/wasm-core/test.mjs

# 3mf project import — the painting codec/rebasing (kernel) and the parser/settings coercion (JS)
node packages/wasm-core/test_paint_import.mjs
node packages/viewer/test_3mf_project.mjs

# 3mf project export — the reverse codec (kernel) and the writer, read back through the importer (JS)
node packages/wasm-core/test_paint_export.mjs
node packages/viewer/test_3mf_export.mjs

# Uniform-scale drag ratio, the scale clamp, and layout-independent shortcut matching
node packages/viewer/test_scale_box.mjs

# Undo/redo stack semantics (branch discard, coalescing, limit)
node packages/viewer/test_history.mjs

# Rebuild the kernel (needs emscripten + brew boost/eigen)
bash packages/wasm-core/build.sh

# Regenerate the extracted JSON (slicers/slicer sources -> packages/data/)
python3 web/extract_all.py

# Regenerate the settings key types (config-schema.json -> types/settings-keys.d.ts, 923 keys). build runs this automatically
node packages/types/gen_settings_types.mjs

# Standalone tarball verification (4 consumers: Node/types/Vite/Next) — must live inside packages/
bash packages/pack_check.sh
```

## Structure

All of `packages/` is **one npm package, `three-slicer`** (consumed piecewise via subpath exports):
- `packages/engine/` — the entry point `three-slicer` (+`/settings` `/toggle` `/worker` `/wasm`): the WASM kernel SDK
- `packages/data/` — the extracted artifacts: config-schema, ui-tree, toggle-rules, invalidation-map, printers
  (vendor machine profiles: motion limits + bed/nozzle), processes (print presets — speeds/accelerations) and
  filaments (material presets — temperatures, flow, cooling, retraction overrides; joined to printers by
  `compatible_printers`, with each machine model's `default_materials` as the recommended list).
  `processes`/`filaments` are emitted as **`.js` modules, not JSON**, because they are loaded dynamically: a dynamic JSON import
  needs `with { type: 'json' }` in Node, and that same attribute makes browsers reject a dev server's
  `text/javascript` response. The large artifacts are column-oriented and deduplicated — read them through
  `printerSettings()` / `processPresets()` / `filamentPresets()` in `three-slicer/settings`, not by hand.
  Both preset artifacts carry only the keys some preset actually sets, so their key sets stay disjoint and
  applying one never clears another's values.
  New artifacts must also be added to `packages/package.json` `files`, or they are missing from the tarball.
  Prefer consuming `three-slicer/data` (named exports, import attribute included) — the raw `three-slicer/data/*.json` is available too.
  **When importing a new JSON file, always add it to `engine/src/data.js`**: Vite/esbuild strip
  `with { type: 'json' }` from bundle output, so with more than one import site the consumer's bundler warns about mismatched attributes.
- `packages/components/` — `three-slicer/components`: the React `<SettingsPanel/>` (zero global coupling, Shadow DOM)
- `packages/viewer/` — `three-slicer/viewer`: the `<Viewport/>` viewer component (three.js, Shadow DOM)
- `packages/types/` — all the `.d.ts` files. Hand-written, except `settings-keys.d.ts` (923 keys) which `gen_settings_types.mjs` generates
- `packages/wasm-core/` — the kernel C++ sources + `third_party/` (a copy of the deps, for standalone builds) — not published to npm; its output lands in `packages/engine/src/`
- `web/viewer/` — the demo app (Vite + React) — a workspace member that references the package by name
