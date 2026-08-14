// Where the prime tower stands, per plate — the same rules the slicer applies, so the drawn stand-in and the
//  sliced tower are the same tower. Pure arithmetic on settings + the plate's model bounds, kept out of the
//  component because "the box shows where it will actually print" is a claim only an assertion can hold up.

/** Read a per-plate tower coordinate out of the settings map. `wipe_tower_x`/`_y` are upstream's per-plate
 *  ARRAYS, so each plate reads its own entry — a hole (null) means auto for that plate only. A legacy scalar
 *  still applies to every plate alike. NaN means "not chosen", which is what turns on auto placement. */
export function chosenTowerCoord(settings, key, plate) {
  const raw = settings?.[key]
  const value = Array.isArray(raw) ? raw[plate] : raw
  const asNumber = Number(value)
  return (value != null && value !== '' && Number.isFinite(asNumber)) ? asNumber : NaN
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const AUTO_GAP = 5   // mm between the model and an auto-placed tower

/** One box per plate that gets a tower, in the bed-centred world coordinates the objects use.
 *  Every plate slices with its own tower (the kernel is per-plate), so every plate with objects gets one.
 *  An empty plate gets none: the kernel has nothing to slice there, so a box would promise a tower that
 *  never prints.
 *  `modelBounds(plate)` and `plateOrigin(plate)` are the scene's; everything else is arithmetic.
 *  Returns null when there is no tower at all, which is what the scene takes as "remove them". */
export function towerBoxes({ plateCount, size, bedWidth, bedDepth, settings, modelBounds, plateOrigin }) {
  const boxes = []
  for (let plate = 0; plate < plateCount; plate++) {
    const box = modelBounds(plate)
    if (!box) continue
    const setX = chosenTowerCoord(settings, 'wipe_tower_x', plate)
    const setY = chosenTowerCoord(settings, 'wipe_tower_y', plate)
    const auto = !Number.isFinite(setX)
    // The box is drawn in world coordinates and a bed coordinate is plate-local, so the plate's own origin is
    //  the one conversion between them — the same origin the slice frame subtracts.
    const origin = plateOrigin(plate) ?? { x: 0, z: 0 }
    // Auto mirrors use_slicer's placement exactly: one gap to the model's left, level with the model's middle,
    //  clamped to the bed. Both read the same box in the same frame, so the drawn tower is the sliced one.
    const x = auto ? origin.x + clamp(box.minX - origin.x - AUTO_GAP - size / 2, -bedWidth / 2 + size / 2, bedWidth / 2 - size / 2)
                   : origin.x + setX - bedWidth / 2 + size / 2
    const y = auto ? -origin.z + clamp((box.minY + box.maxY) / 2 + origin.z, -bedDepth / 2 + size / 2, bedDepth / 2 - size / 2)
                   : -origin.z + setY - bedDepth / 2 + size / 2
    boxes.push({ plate, x, y, size, height: Math.max(2, box.height) })
  }
  return boxes.length ? boxes : null
}
