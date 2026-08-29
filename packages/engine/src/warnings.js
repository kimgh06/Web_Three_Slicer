// Result-level warnings — the slices that succeed while being wrong.
//
// The kernel reports an off-bed model as one flag among twenty stats numbers (`over_bed_model`), which a consumer
// only finds by already knowing it exists: a bed-centred model handed in without the plate-local subtraction slices
// at X 234.7–265.4 on a 250mm bed with plausible time and material and no error (examples/DEMOS.md §4.5). All four
// demos ended up writing the same `if (result.stats.over_bed_model) throw` line. Naming the whole set on the result
// lets a host surface or log every such condition without knowing which flags the kernel happens to carry.
//
// Warnings are strings, and the array is always present so `result.warnings.length` needs no guard. The stats flags
// stay exactly where they were — this is an additional view of them, not a replacement.

/** @param {object} [stats] a slice result's `stats` @returns {string[]} */
export function sliceWarnings(stats) {
  const warnings = []
  if (stats?.over_bed_model) warnings.push('over_bed_model')
  return warnings
}

/** Attaches `warnings` to a slice result in place (the result is a fresh object per slice) and returns it. */
export function withSliceWarnings(result) {
  if (result && !result.error) result.warnings = sliceWarnings(result.stats)
  return result
}
