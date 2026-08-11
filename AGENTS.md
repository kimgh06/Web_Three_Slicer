# AGENTS.md

Web_Three_Slicer — a browser/WASM slicer reverse-engineered from OrcaSlicer. The root holds three folders:

- **`slicer/`** — the upstream OrcaSlicer sources (unmodified, for reference and extraction only). Its own guide is `slicer/AGENTS.md`.
- **`packages/`** — the published npm package `three-slicer` (a single one) plus the kernel sources. Zero build or runtime dependency on `slicer/`.
- **`web/`** — the demo app shell. It consumes the package as a workspace (no relative-path imports). Details: `web/README.md`, `web/GUIDE.md`, `web/SPECS.md`.

The root `package.json` is the npm workspaces root (`packages/*` + `web/viewer`) — a single `npm i` at the root installs everything.

## Core rules

- **Never modify `slicer/`.** All development happens in `packages/` and `web/`.
- `packages/` and `web/` must run, build and publish without `slicer/` (demonstrated in stage 34). Do not make changes that break this independence.
- Changes to the kernel (`packages/wasm-core/`) must pass the golden byte-identical check (`golden.mjs`) and the `test.mjs` invariant suite.
- Multi-material widened what "byte-identical" has to cover. Three conditions, each with its own `test.mjs` invariant, must keep producing the output the kernel produced before the feature existed: **no painted facets**, **no per-extruder arrays** (`extruder_nozzle_temp`, `extruder_flow_ratio`, `extruder_retract_*`, `extruder_z_hop`), **`support_filament` 0**. All three hold by omission rather than by a default: `deriveKernelParams` leaves those keys out of the params object entirely (89 keys from an empty settings map, 93 with two extruders and a support filament), and `Params::forTool` / `support_tool_of` fall back to the scalar and to "emit no `T` command at all".
- One material per extruder. Upstream stores every filament option as one entry per extruder, so the kernel takes per-extruder vectors and reads them **positionally** — a hole must be filled with the value tool 0 resolved to, because the kernel cannot tell "absent" from 0. On every `T` change `slice_multimaterial` reloads the whole loaded-filament set (diameter, flow, retraction length/speed, z-hop, and `M109` when the temperatures actually disagree).
- Support painting and material painting are **one** ported TriangleSelector, because upstream's `EnforcerBlockerType` is one enum: `ENFORCER`==Extruder1, `BLOCKER`==Extruder2, `Extruder3..16`==3..16. So a facet holds one integer, and a support BLOCKER paint is indistinguishable from an Extruder2 paint. `slice()` therefore routes a painted model to the multi-material path only when support is **off** (`slicer_core.cpp`) — `slice_multimaterial` emits no support at all, so routing a support-enabled slice there would silently drop it. Consequence to state plainly: **paint and support cannot currently produce two materials together.**
- Painted regions come from upstream's exact per-layer segmentation, `MultiMaterialSegmentation.cpp`, ported to `packages/wasm-core/treesupport_port/libslic3r/`. Everything above its driver is upstream verbatim; the driver was rewritten because upstream's takes a `PrintObject` (nothing in this kernel has one) — it now takes the sliced contour of every layer plus the selector's painted facets, through `selector_bridge::segment_prepare` / `segment_regions`. Two consequences: `slice_mm.cpp` must slice **every** layer up front (the segmentation is a whole-object pass, and it reuses those contours so nothing is sliced twice), and a painted flat face reaches the print only through `segmentation_top_and_bottom_layers` — a horizontal facet cuts no slicing plane, so that pass is not optional. Its Voronoi/EdgeGrid/MutablePolygon dependencies were already linked for Arachne; only the one new TU was added to `build.sh`.
- The toolpath stream's role field (`paths[k+3]`, stride 8) encodes `role + tool * 16`. Roles only reach 11, so the tool rides in the spare high bits rather than a 9th float — the segment stream is the largest array the viewer holds and a 9th float costs +12.5% of it for one small integer. **Anything reading that field must mask** (`& 15` for the role, `>>> 4` for the tool); pre-encoding output is entirely below 16 and decodes to its own role with tool 0.
- `web/extract_all.py` derives the kernel key list by regex-scanning `packages/engine/src/settings.js` for single-quoted lowercase strings and keeping the ones that are schema keys — **it does not strip comments**. Measured: appending only the comment `// note: the 'interface_shells' option is not wired up yet` takes the list from 92 keys to 93 and adds that column to every extracted preset. Never write a schema key name in quotes in a comment in that file.
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

# Rebuild the kernel (needs emscripten + brew boost/eigen)
bash packages/wasm-core/build.sh

# Regenerate the extracted JSON (slicer/ sources -> packages/data/)
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
