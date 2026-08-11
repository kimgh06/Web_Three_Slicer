// Slicer worker factory — this file is not bundled; the build script copies it verbatim into dist/.
// Why: for consumer bundlers (Vite/webpack) to recognize the worker as a chunk, the static
// `new Worker(new URL('literal', import.meta.url))` pattern must survive in a file the consumer sees. If the viewer's own
// lib build handled it, the worker would be frozen into a site-root-absolute asset path and 404 in consumer apps.
// The '../../engine/…' path is relative to dist/: it resolves to the engine package both in the monorepo
// (packages/viewer/dist -> packages/engine) and in an npm install (sibling directory under the @three-slicer/ scope).
export function makeSlicerWorker() {
  return new Worker(new URL('../../engine/src/slicer.worker.js', import.meta.url), { type: 'module' })
}

// 3MF parsing worker. Unlike the slicer worker this one points INTO dist/ — the viewer's `src/` is not published
// (packages/package.json `files` ships `viewer/dist` only), so the worker is a lib entry of the viewer's own build
// and lands beside this file. The static `new Worker(new URL(…))` pattern is what matters either way.
export function makeParse3mfWorker() {
  return new Worker(new URL('./parse_3mf.worker.js', import.meta.url), { type: 'module' })
}
