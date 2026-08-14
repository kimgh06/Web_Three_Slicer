// The plate grid — the one rule the scene, the 3mf writer and the G-code injection all have to agree on.
//   Run: node packages/viewer/test_plate_layout.mjs
// Characterization: every expectation below is the value the closure in use_three_scene.js produced before the
//  grid moved into this module, so a change to either function has to be a deliberate one.
import assert from 'node:assert'
import {
  PLATE_GAP, MAX_PLATES, plateStep, plateCols, platePosition, plateIndexAtXZ, UPSTREAM_PLATE_GAP_RATIO,
} from './src/core/plate_layout.js'

// ---- the constants other modules encode into files ----
assert.equal(PLATE_GAP, 40)
assert.equal(MAX_PLATES, 9)
assert.equal(UPSTREAM_PLATE_GAP_RATIO, 1 / 5)   // write_3mf/model_load re-encode upstream's grid with this
assert.equal(plateStep(200), 240)
assert.equal(plateStep(256), 296)               // the Bambu bed — 296 here vs upstream's 307.2 (see AGENTS.md)

// ---- column count: upstream PartPlate.hpp compute_colum_count, cols ~= ceil(sqrt(n)) ----
assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(plateCols), [1, 2, 2, 2, 3, 3, 3, 3, 3])

// ---- plate 0 is the world origin, so a single-plate project needs no offset at all ----
assert.deepEqual(platePosition(0, 1, 200, 200), { x: 0, z: 0 })

// ---- the grid fills columns first, then rows (rows grow along +z) ----
const grid4 = [0, 1, 2, 3].map(i => platePosition(i, 4, 200, 200))
assert.deepEqual(grid4, [{ x: 0, z: 0 }, { x: 240, z: 0 }, { x: 0, z: 240 }, { x: 240, z: 240 }])

// A non-square bed steps by its own edge on each axis — x by the width, z by the depth.
assert.deepEqual(platePosition(3, 4, 300, 100), { x: 340, z: 140 })

// ---- plateIndexAtXZ is the inverse: every plate centre maps back to its own index ----
for (const count of [1, 2, 3, 4, 5, 9]) {
  for (const [bedWidth, bedDepth] of [[200, 200], [256, 256], [300, 100]]) {
    for (let i = 0; i < count; i++) {
      const p = platePosition(i, count, bedWidth, bedDepth)
      assert.equal(plateIndexAtXZ(p.x, p.z, count, bedWidth, bedDepth), i,
        `round trip failed: plate ${i} of ${count} on ${bedWidth}x${bedDepth}`)
    }
  }
}

// Nearest centre, not containment: anywhere inside a plate's own half-step belongs to it.
assert.equal(plateIndexAtXZ(119, 0, 4, 200, 200), 0)    // just short of the halfway point (120)
assert.equal(plateIndexAtXZ(121, 0, 4, 200, 200), 1)    // just past it

// ---- out of range clamps into the grid rather than returning a plate that does not exist ----
assert.equal(plateIndexAtXZ(-5000, -5000, 4, 200, 200), 0)
assert.equal(plateIndexAtXZ(5000, 5000, 4, 200, 200), 3)
assert.equal(plateIndexAtXZ(5000, 5000, 3, 200, 200), 2)   // 3 plates in a 2-col grid: the last one, not row*cols+col=3
assert.equal(plateIndexAtXZ(0, 0, 1, 200, 200), 0)

console.log('plate_layout: ok')
