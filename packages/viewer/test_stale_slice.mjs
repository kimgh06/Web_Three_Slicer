// What a settings change does to a result already on screen (src/core/slice_staleness.js).
//
// The behaviour it guards: everything shown after a slice — toolpaths, the stats card, the layer slider, the
// G-code export — describes the settings it was sliced with, and none of it says so. Change a setting and the
// preview keeps rendering, the estimate keeps reading plausibly, and Export keeps handing out G-code the current
// settings would not produce.
//   run: node packages/viewer/test_stale_slice.mjs
import { sameSettings, survivesSettingsChange } from './src/core/slice_staleness.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

console.log('\n[staleness: did the settings actually change]')
check('the same object is the same settings', sameSettings({ layer_height: 0.2 }, { layer_height: 0.2 }))
check('a changed value is a change', !sameSettings({ layer_height: 0.2 }, { layer_height: 0.3 }))
check('an added key is a change', !sameSettings({ layer_height: 0.2 }, { layer_height: 0.2, wall_loops: 3 }))
check('a removed key is a change', !sameSettings({ layer_height: 0.2, wall_loops: 3 }, { layer_height: 0.2 }))
// A host that rebuilds its settings object every render must not wipe the preview on every render — which is
//  what an identity comparison would do, since every render hands over a fresh object.
check('a rebuilt object with equal values is not a change',
  sameSettings({ layer_height: 0.2, spiral_mode: false }, { ...{ layer_height: 0.2, spiral_mode: false } }))
// printable_area is written as a FRESH array whenever the bed is set, so identity alone reports an unchanged
//  bed as a change and would invalidate on every bed write that changed nothing.
const bed = [[0, 0], [200, 0], [200, 200], [0, 200]]
check('an equal array rebuilt is not a change',
  sameSettings({ printable_area: bed }, { printable_area: [[0, 0], [200, 0], [200, 200], [0, 200]] }))
check('a different array IS a change',
  !sameSettings({ printable_area: bed }, { printable_area: [[0, 0], [250, 0], [250, 200], [0, 200]] }))
check('an empty map equals an empty map', sameSettings({}, {}))
check('null is handled like an empty map', sameSettings(null, {}))

console.log('\n[staleness: which results survive]')
// An imported archive is not a slice of these settings and never claimed to be — and the import itself WRITES
//  settings (it applies the archive's own), so invalidating on that write would erase what was just opened.
check('an opened .sl1 archive survives', survivesSettingsChange({ stats: { sla: true, sla_raster: true } }))
check('an SLA slice does not survive', !survivesSettingsChange({ stats: { sla: true } }))
check('an FFF slice does not survive', !survivesSettingsChange({ stats: { layers: 100 } }))
check('a result without stats does not survive', !survivesSettingsChange({ layers: [] }))
check('an empty slot is not mistaken for a keeper', !survivesSettingsChange(undefined))

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL STALE-SLICE CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
