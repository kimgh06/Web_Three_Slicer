// Per-plate settings (src/core/plate_settings.js): the sparse-override merge, the blocked-key gate, and the
// isolation contract — a plate with no override must slice EXACTLY as it did before the feature existed.
//
// The isolation check compares derived kernel params (not G-code) across three conditions in one process:
// plateSettings absent, empty, and holding another plate's override. Identical params into a deterministic
// kernel is identical output, and comparing here keeps the invariant runnable without the WASM build.
//   run: node packages/viewer/test_plate_settings.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { effectiveSettings, truncatePlateSettings, overriddenPlateKeys, writePlateOverride, revertPlateKey,
  plateTechnology, plateBedBounds, plateDimsList, uniformPlateDims,
  assertUniformTechnology, MixedTechExportError, assertHomogeneousBeds, MixedBedExportError,
  PLATE_SETTING_BLOCKED_KEYS, switchTechOverrides } from './src/core/plate_settings.js'
import { deriveKernelParams } from '../engine/src/settings.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}
const paramsJson = (settings, plate = 0) => JSON.stringify(deriveKernelParams(settings, { plate }))

console.log('\n[merge: absence means "follow the global value"]')
const globalMap = { layer_height: 0.2, wall_loops: 2, sparse_infill_density: 15 }
check('no plateSettings returns the global map by identity',
  effectiveSettings(globalMap, undefined, 0) === globalMap)
check('an empty plateSettings map returns the global map by identity',
  effectiveSettings(globalMap, {}, 0) === globalMap)
check('an override on ANOTHER plate returns the global map by identity',
  effectiveSettings(globalMap, { 1: { layer_height: 0.3 } }, 0) === globalMap)
check('an empty override returns the global map by identity',
  effectiveSettings(globalMap, { 0: {} }, 0) === globalMap)
check('an undefined override value is key-absent, not an override',
  effectiveSettings(globalMap, { 0: { layer_height: undefined } }, 0) === globalMap)
const merged = effectiveSettings(globalMap, { 0: { layer_height: 0.3 } }, 0)
check('an override merges only its own keys', merged.layer_height === 0.3 && merged.wall_loops === 2)
check('the merge does not mutate the global map', globalMap.layer_height === 0.2)

console.log('\n[blocked keys: the gate machinery, now with an empty list (heterogeneous-bed stage)]')
check('no key is blocked any more — beds and technology are per-plate',
  JSON.stringify(PLATE_SETTING_BLOCKED_KEYS) === JSON.stringify([]))
check('a bed override now reaches the kernel params', (() => {
  const p = JSON.parse(paramsJson(effectiveSettings({}, { 0: { printable_height: 123 } }, 0)))
  return p.bed_height === 123
})())

console.log('\n[per-plate technology: each plate routes by its own effective map]')
check('no override follows the global technology', plateTechnology({ printer_technology: 'SLA' }, {}, 0) === 'SLA')
check('an SLA override routes only its plate',
  plateTechnology({}, { 1: { printer_technology: 'SLA' } }, 1) === 'SLA'
  && plateTechnology({}, { 1: { printer_technology: 'SLA' } }, 0) === 'FFF')
check('an FFF override on a globally-SLA project routes back to FFF',
  plateTechnology({ printer_technology: 'SLA' }, { 0: { printer_technology: 'FFF' } }, 0) === 'FFF')
check('anything not SLA reads as FFF', plateTechnology({ printer_technology: 'weird' }, {}, 0) === 'FFF')

console.log('\n[mixed tech: per-plate bounds, overlays, and the typed 3mf refusal]')
// slaDims is injected (the real one is deriveSlaParams) — a stub keeps these checks about the routing.
const dims = (map) => ({ display_width: map.display_width, display_height: map.display_height })
const kpBounds = { bedW: 200, bedD: 200, bedH: 250 }
const mixedPs = { 1: { printer_technology: 'SLA', display_width: 120.96, display_height: 68.04 } }
check('an FFF plate keeps the global bounds', plateBedBounds({}, mixedPs, 0, kpBounds, dims) === kpBounds)
check('an SLA-override plate is judged against its display', (() => {
  const b = plateBedBounds({}, mixedPs, 1, kpBounds, dims)
  return b.bedW === 120.96 && b.bedD === 68.04 && b.bedH === 0
})())
check('a globally-SLA project keeps kp (already display-sized)',
  plateBedBounds({ printer_technology: 'SLA' }, {}, 0, kpBounds, dims) === kpBounds)
check('an SLA override without display dims falls back to the global bounds',
  plateBedBounds({}, { 1: { printer_technology: 'SLA' } }, 1, kpBounds, dims) === kpBounds)
check('an SLA plate\'s grid cell IS its display', (() => {
  const cells = plateDimsList({}, mixedPs, 2, { w: 200, d: 200 }, undefined, dims)
  return cells[0].w === 200 && cells[1].w === 120.96 && cells[1].d === 68.04
})())
check('a globally-SLA project keeps the global cells (kp is already display-sized)', (() => {
  const cells = plateDimsList({ printer_technology: 'SLA' }, mixedPs, 2, { w: 120, d: 68 }, undefined, dims)
  return cells[0].w === 120 && cells[1].w === 120
})())
check('a uniform project exports', (() => { assertUniformTechnology({}, { 1: { layer_height: 0.1 } }); return true })())
check('a mixed project is refused with the typed code', (() => {
  try { assertUniformTechnology({}, mixedPs); return false }
  catch (e) { return e instanceof MixedTechExportError && e.code === 'UNSUPPORTED_MIXED_TECH_3MF' && e.plates.includes(1) && /[Pp]lates 2/.test(e.message) }
})())
check('an FFF override on a globally-SLA project is mixed too', (() => {
  try { assertUniformTechnology({ printer_technology: 'SLA' }, { 0: { printer_technology: 'FFF' } }); return false }
  catch (e) { return e.code === 'UNSUPPORTED_MIXED_TECH_3MF' }
})())

console.log('\n[isolation: the no-override path is the pre-feature path]')
// The empty-map omission invariant rides along: deriveKernelParams({}) is pinned at 93 params by the engine
// suite, and every one of these conditions must produce that exact object.
const base = paramsJson({})
check('plateSettings absent slices with the pre-feature params', paramsJson(effectiveSettings({}, undefined, 0)) === base)
check('plateSettings {} slices with the pre-feature params', paramsJson(effectiveSettings({}, {}, 0)) === base)
check('another plate\'s override leaves this plate\'s params untouched',
  paramsJson(effectiveSettings({}, { 1: { layer_height: 0.3 } }, 0)) === base)
check('this plate\'s override DOES move its params',
  paramsJson(effectiveSettings({}, { 0: { layer_height: 0.3 } }, 0)) !== base)
check('a rescaled setting rescales through the override path too',
  deriveKernelParams(effectiveSettings({}, { 0: { sparse_infill_density: 40 } }, 0)).infill_density === 0.4)

console.log('\n[ownership: index contract, truncation is the erase]')
const overrides = { 0: { layer_height: 0.3 }, 2: { wall_loops: 4 } }
const truncated = truncatePlateSettings(overrides, 2)
check('deleting the last plate drops its override', truncated[2] === undefined)
check('the surviving plates keep their overrides by identity', truncated[0] === overrides[0])
check('a delete with nothing to drop returns the same reference (no phantom staleness)',
  truncatePlateSettings(overrides, 3) === overrides)
check('null plateSettings passes through', truncatePlateSettings(null, 1) === null)

console.log('\n[panel projection: edits on the effective map become overrides]')
// The scope toggle's write path (Viewport processCard): the panel edited the plate's effective map
// before -> after, and only the CHANGE becomes an override — the per-plate mirror of FilamentCard's
// per-extruder setPanelSettings.
const g2 = { layer_height: 0.2, wall_loops: 2 }
const eff = effectiveSettings(g2, {}, 1)
let written = writePlateOverride({}, 1, eff, { ...eff, layer_height: 0.1 })
check('a changed value becomes that plate\'s override', written[1]?.layer_height === 0.1)
check('an unchanged value does not become an override', !('wall_loops' in (written[1] ?? {})))
check('an edit equal to the global value writes nothing', writePlateOverride({}, 1, eff, { ...eff })[1] === undefined)
check('a bed edit writes into the override (no longer blocked)', writePlateOverride({}, 1, eff, { ...eff, printable_height: 999 })[1]?.printable_height === 999)
check('a no-op write returns the same reference', (() => { const ps = { 0: { wall_loops: 3 } }; return writePlateOverride(ps, 1, eff, { ...eff }) === ps })())
// The panel's per-option reset removes the key from `after`. On an overridden key that clears the override
// (follow global again); on a purely global key plate scope has nothing to delete and must not invent an override.
const withOv = { 1: { layer_height: 0.1 } }
const effOv = effectiveSettings(g2, withOv, 1)
const { layer_height, ...resetMap } = effOv
check('resetting an overridden key clears the override (and drops the empty map)',
  writePlateOverride(withOv, 1, effOv, resetMap)[1] === undefined)
check('resetting a global-only key writes nothing', (() => {
  const { wall_loops, ...m } = eff; return writePlateOverride({}, 1, eff, m)[1] === undefined
})())

console.log('\n[badges: overridden keys and the revert]')
check('overriddenPlateKeys lists the plate\'s own keys', JSON.stringify(overriddenPlateKeys({ 1: { layer_height: 0.1 } }, 1)) === '["layer_height"]')
check('a bed override is a reportable key now', overriddenPlateKeys({ 1: { printable_area: [[0, 0]] } }, 1).length === 1)
check('no override reports no keys', overriddenPlateKeys({}, 0).length === 0)
const reverted = revertPlateKey({ 1: { layer_height: 0.1, wall_loops: 4 } }, 1, 'layer_height')
check('revert drops exactly one key', reverted[1]?.wall_loops === 4 && !('layer_height' in reverted[1]))
check('reverting the last key drops the plate entry whole', revertPlateKey({ 1: { layer_height: 0.1 } }, 1, 'layer_height')[1] === undefined)
check('reverting an absent key returns the same reference', (() => { const ps = { 1: { wall_loops: 4 } }; return revertPlateKey(ps, 1, 'layer_height') === ps })())

console.log('\n[heterogeneous beds: per-plate cells, bounds and the typed 3mf refusal]')
const fff = (map) => { const p = deriveKernelParams(map); return { bed_width: p.bed_width, bed_depth: p.bed_depth, bed_height: p.bed_height } }
const bedPs = { 1: { printable_area: [[0, 0], [330, 0], [330, 330], [0, 330]] } }
check('a bed-override plate is judged against ITS bed', (() => {
  const b = plateBedBounds({}, bedPs, 1, { bedW: 200, bedD: 200, bedH: 250 }, undefined, fff)
  return b.bedW === 330 && b.bedD === 330
})())
check('plates without a bed override keep the global bounds',
  plateBedBounds({}, bedPs, 0, kpBounds, undefined, fff) === kpBounds)
check('plateDimsList sizes each cell', (() => {
  const dims = plateDimsList({}, bedPs, 2, { w: 200, d: 200 }, fff)
  return dims[0].w === 200 && dims[1].w === 330 && dims[1].d === 330
})())
check('an SLA plate\'s cell follows its display even beside a bed override', (() => {
  const cells = plateDimsList({}, { 1: { printer_technology: 'SLA', display_width: 82.62, display_height: 130.56, printable_area: [[0, 0], [330, 0], [330, 330], [0, 330]] } }, 2, { w: 200, d: 200 }, fff, dims)
  return cells[1].w === 82.62 && cells[1].d === 130.56
})())
check('uniformPlateDims tells the closed form from the cumulative one',
  uniformPlateDims([{ w: 200, d: 200 }, { w: 200, d: 200 }]) && !uniformPlateDims([{ w: 200, d: 200 }, { w: 330, d: 330 }]))
check('a homogeneous project exports', (() => { assertHomogeneousBeds({ 1: { layer_height: 0.1 } }); return true })())
check('a mixed-bed project is refused with the typed code', (() => {
  try { assertHomogeneousBeds(bedPs); return false }
  catch (e) { return e instanceof MixedBedExportError && e.code === 'UNSUPPORTED_MIXED_BED_3MF' && e.plates.includes(1) }
})())

console.log('\n[technology switch: a plate override is set aside with the technology it was authored under]')
// The reported flow: globally resin, a plate tuned in PLATE scope, then globally back to filament. The override
// was authored against SLA — and the keys do not say so (a plate printer pick records only what it CHANGED, and
// the Resin card writes layer_height / initial_layer_height, which are FFF keys too), so left in place it shadows
// every later printer, model and preset pick on that plate. It is stashed, and returns with the technology.
const resinEra = { 1: { layer_height: 0.05, initial_layer_height: 0.05, exposure_time: 2.3 }, 2: { printer_technology: 'SLA', exposure_time: 4 } }
const toFff = switchTechOverrides(resinEra, {}, 'SLA', 'FFF')
check('a resin-era override leaves the plate when the global technology changes', !toFff.plateSettings[1] && toFff.stashed.includes(1))
check('the plate follows the new global values again',
  effectiveSettings({ printer_technology: 'FFF', layer_height: 0.2 }, toFff.plateSettings, 1).layer_height === 0.2)
check('a deliberate mixed-technology override stays in place by identity', toFff.plateSettings[2] === resinEra[2] && !toFff.stashed.includes(2))
check('the stash holds it under the technology it left', toFff.stash[1].SLA === resinEra[1])
check('the input map is copied, not mutated', resinEra[1].layer_height === 0.05)
const fffEdit = { ...toFff.plateSettings, 1: { layer_height: 0.3 } }
const stayed = switchTechOverrides(fffEdit, toFff.stash, 'FFF', 'SLA')
check('coming back stashes the FFF-era edit and restores the resin one', stayed.plateSettings[1] === resinEra[1] && stayed.stash[1].FFF === fffEdit[1] && !stayed.stash[1].SLA)
const back = switchTechOverrides(toFff.plateSettings, toFff.stash, 'FFF', 'SLA')
check('a round trip restores the override and empties the stash', back.plateSettings[1] === resinEra[1] && back.restored.includes(1) && !back.stash[1])
check('nothing to move returns both maps by identity', (() => {
  const ps = { 2: { printer_technology: 'SLA' } }, st = {}
  const r = switchTechOverrides(ps, st, 'FFF', 'SLA')
  return r.plateSettings === ps && r.stash === st && !r.stashed.length && !r.restored.length
})())
check('the same technology moves nothing', switchTechOverrides(resinEra, {}, 'SLA', 'SLA').plateSettings === resinEra)
check('a profile pick is written whole, so a later global pick cannot mix two machines', (() => {
  // The same-technology half of the report: plate picks machine B while the global machine is A, then the global
  // machine moves to C. Recorded as a diff, every key B shares with A would follow C and leave the plate on neither.
  const A = { m_bed: 200, m_nozzle: 0.4, printer_settings_id: 'A' }
  const B = { m_bed: 200, m_nozzle: 0.6 }   // m_bed is the shared key the diff rule would drop
  const force = [...Object.keys(B), 'printer_settings_id']
  const ps = writePlateOverride({}, 1, A, { ...B, printer_settings_id: 'B' }, force)
  const C = { m_bed: 300, m_nozzle: 0.4, printer_settings_id: 'C' }
  const eff = effectiveSettings(C, ps, 1)
  return eff.m_bed === 200 && eff.m_nozzle === 0.6 && eff.printer_settings_id === 'B'
})())
check('a forced write with nothing new returns the same reference', (() => {
  const ps = { 1: { m_nozzle: 0.6, printer_settings_id: 'B' } }
  return writePlateOverride(ps, 1, { m_nozzle: 0.4 }, { m_nozzle: 0.6, printer_settings_id: 'B' }, ['m_nozzle', 'printer_settings_id']) === ps
})())

console.log('\n[doc gate: the blocked-key list in AGENTS.md is the exported one]')
// The code is the source of truth (PLATE_SETTING_BLOCKED_KEYS above); AGENTS.md must name every key so the
// documented contract cannot drift from the enforced one — same direction as test_kernel_params.mjs for PARAMS.md.
const agentsMd = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8')
for (const key of PLATE_SETTING_BLOCKED_KEYS)
  check(`AGENTS.md names blocked plate key ${key}`, agentsMd.includes(key))
check('AGENTS.md mentions the per-plate settings contract', agentsMd.includes('plateSettings'))

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL PLATE-SETTINGS CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
