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

# Regenerate the settings key types (config-schema.json -> types/settings-keys.d.ts, 907 keys). build runs this automatically
node packages/types/gen_settings_types.mjs

# Standalone tarball verification (4 consumers: Node/types/Vite/Next) — must live inside packages/
bash packages/pack_check.sh
```

## Structure

All of `packages/` is **one npm package, `three-slicer`** (consumed piecewise via subpath exports):
- `packages/engine/` — the entry point `three-slicer` (+`/settings` `/toggle` `/worker` `/wasm`): the WASM kernel SDK
- `packages/data/` — the 4 extracted JSON files (config-schema, ui-tree, toggle-rules, invalidation-map).
  Prefer consuming `three-slicer/data` (named exports, import attribute included) — the raw `three-slicer/data/*.json` is available too.
  **When importing a new JSON file, always add it to `engine/src/data.js`**: Vite/esbuild strip
  `with { type: 'json' }` from bundle output, so with more than one import site the consumer's bundler warns about mismatched attributes.
- `packages/components/` — `three-slicer/components`: the React `<SettingsPanel/>` (zero global coupling, Shadow DOM)
- `packages/viewer/` — `three-slicer/viewer`: the `<Viewport/>` viewer component (three.js, Shadow DOM)
- `packages/types/` — all the `.d.ts` files. Hand-written, except `settings-keys.d.ts` (907 keys) which `gen_settings_types.mjs` generates
- `packages/wasm-core/` — the kernel C++ sources + `third_party/` (a copy of the deps, for standalone builds) — not published to npm; its output lands in `packages/engine/src/`
- `web/viewer/` — the demo app (Vite + React) — a workspace member that references the package by name
