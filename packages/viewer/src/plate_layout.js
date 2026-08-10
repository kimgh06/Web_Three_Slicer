// Plate spacing — fixed mm. (Upstream uses 1/5 of the width, but we keep a constant gap regardless of bed size.)
export const PLATE_GAP = 40
export const plateStep = (edge) => edge + PLATE_GAP
// Square plate layout — upstream PartPlate.hpp compute_colum_count: cols ≈ ceil(sqrt(n)).
//  Plate i = (col=i%cols)*stepX, (row=i/cols)*stepZ (upstream grows along -Y -> +z in three).
export const MAX_PLATES = 9
export const plateCols = (count) => { const v = Math.sqrt(count), r = Math.round(v); return v > r ? r + 1 : r }
