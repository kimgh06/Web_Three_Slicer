// three-slicer/toggle — the evaluator from the permissive package, bound to upstream's toggle rules.
// The rules (toggle-rules.json, extracted from OrcaSlicer's toggle_options) and the full schema are this
// package's data; the evaluator itself is three-slicer-viewer's. Same surface as before the split.
import { makeToggle, evalEnableIf } from 'three-slicer-viewer/toggle'
import { toggleRules, schema } from './data.js'
const bound = makeToggle(toggleRules, schema)
export const makeCfg = bound.makeCfg
export const disabledKeys = bound.disabledKeys
export { evalEnableIf }
