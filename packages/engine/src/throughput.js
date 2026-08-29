// How fast the slice actually ran.
//
// The kernel already times its own phases (`t_pass1_ms`, `t_surface_ms`, `t_support_ms`, `t_emit_ms` — set
// unconditionally in finish.cpp), but a phase breakdown is a profiling tool, not an answer to "how fast is this".
// The wall time around the call is, and only the caller can measure it: it includes the STL crossing the WASM
// boundary and, in the worker, the layer stream leaving it.
//
// `msPerMsegment` is the field to compare runs with, and it is not decoration. The kernel is not deterministic in
// segment COUNT — the same input has been measured 15% apart between runs — so a raw millisecond figure compares
// two different amounts of work and reads as a regression that is not there. Normalizing by the work done is what
// makes two numbers comparable; `layersPerSecond` is the one to show a person, since layers are what a progress
// bar counts.
//
// Everything here is derived. Nothing replaces or renames a `stats` field.

// The two technologies time entirely different passes, and only the CONSECUTIVE ones may be summed.
//  FFF: pass1 -> surfaces -> support -> emit (finish.cpp).
//  SLA: contours -> sample -> tree -> raster -> emit (slice_sla.cpp). Its `t_sample_*` and `t_raster_*` keys are
//   nested INSIDE t_sample_ms / t_raster_ms — the C++ says so at each set() — so adding them would double-count.
//  `t_emit_ms` is the one name both use, which is exactly why the FFF list cannot be applied to an SLA result:
//   it would find that single key, sum it alone, and report the emit pass as the whole kernel time.
const FFF_PHASES = ['t_pass1_ms', 't_surface_ms', 't_support_ms', 't_emit_ms']
const SLA_PHASES = ['t_contours_ms', 't_sample_ms', 't_tree_ms', 't_raster_ms', 't_emit_ms']

/**
 * @param {object} [stats] the slice result's `stats`
 * @param {number} wallMs wall time around the slice call, ms
 */
export function sliceThroughput(stats, wallMs) {
  const ms = Math.max(0, Number(wallMs) || 0)
  const layers = Number(stats?.layers) || 0
  // SLA counts mask segments here rather than toolpath segments, which is the same thing for this purpose: the
  //  amount of geometry the run actually produced, so the normalized figure stays comparable within a technology.
  const segments = Number(stats?.path_segments) || 0
  // The kernel's own total, when it reported its phases — always smaller than `ms`, and the gap is the boundary
  //  cost (STL upload, the layer stream, the JS sink). Worth having side by side: a slice that is slow only in
  //  the gap is a marshalling problem, not a slicing one.
  const phases = (stats?.sla ? SLA_PHASES : FFF_PHASES)
    .map(key => Number(stats?.[key])).filter(Number.isFinite)
  return {
    ms,
    kernelMs: phases.length ? phases.reduce((sum, value) => sum + value, 0) : null,
    layersPerSecond: ms > 0 ? (layers * 1000) / ms : 0,
    // Null rather than 0 when there is nothing to normalize against: 0 ms/Mseg would read as infinitely fast.
    msPerMsegment: segments > 0 ? ms / (segments / 1e6) : null,
  }
}

/** Attaches `throughput` to a slice result in place and returns it. */
export function withSliceThroughput(result, wallMs) {
  if (result && !result.error) result.throughput = sliceThroughput(result.stats, wallMs)
  return result
}
