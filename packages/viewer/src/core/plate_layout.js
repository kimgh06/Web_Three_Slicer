// Plate spacing — fixed mm. (Upstream uses 1/5 of the width, but we keep a constant gap regardless of bed size.)
export const PLATE_GAP = 40
export const plateStep = (edge) => edge + PLATE_GAP
// Square plate layout — upstream PartPlate.hpp compute_colum_count: cols ≈ ceil(sqrt(n)).
//  Plate i = (col=i%cols)*stepX, (row=i/cols)*stepZ (upstream grows along -Y -> +z in three).
export const MAX_PLATES = 9
export const plateCols = (count) => { const v = Math.sqrt(count), r = Math.round(v); return v > r ? r + 1 : r }
// Where plate `index` sits in three world coordinates, as an {x, z} offset from plate 0. The scene, the toolpath
//  display offset and the G-code injection all have to agree on this, so it lives here rather than in the closure
//  that happens to need it first — three call sites used to spell the same two multiplications out by hand.
export function platePosition(index, plateCount, bedWidth, bedDepth) {
  const cols = plateCols(plateCount)
  return { x: (index % cols) * plateStep(bedWidth), z: Math.floor(index / cols) * plateStep(bedDepth) }
}
// The inverse: which plate a world (x, z) belongs to = nearest plate centre, clamped into the grid. Used to decide
//  an object's membership from its position alone, which is what makes dragging a model between plates work.
export function plateIndexAtXZ(worldX, worldZ, plateCount, bedWidth, bedDepth) {
  const cols = plateCols(plateCount)
  const col = Math.max(0, Math.min(cols - 1, Math.round(worldX / plateStep(bedWidth))))
  const row = Math.max(0, Math.round(worldZ / plateStep(bedDepth)))
  return Math.max(0, Math.min(plateCount - 1, row * cols + col))
}
// Upstream's OWN grid (PartPlate.cpp compute_shape_position / plate_stride_x): origin at the plate's CORNER,
//  gap = bed/5, rows growing along -y. The 3mf importer decodes positions under this rule and the 3mf writer
//  re-encodes them under it — one constant, or the two silently disagree at every bed size but 200mm.
export const UPSTREAM_PLATE_GAP_RATIO = 1 / 5
