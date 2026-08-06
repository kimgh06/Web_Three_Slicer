// three-slicer/wasm, three-slicer/wasm-mt — emscripten glue (generated, 3.5MB+).
// ponytail: no precise types here. The glue changes on every rebuild, and the public API is
//   createSlicer() from three-slicer. Anyone using this directly already knows the kernel internals.
declare const factory: (opts?: Record<string, unknown>) => Promise<any>
export default factory
