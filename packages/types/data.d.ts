// three-slicer/data — the extracted JSON files. Prefer this over importing the raw JSON:
// the import attribute (`with { type: 'json' }`) is already applied, so it works in Node and bundlers alike.
import type { ConfigOption } from './data/config-schema.json.d.ts'
import type { UIPage } from './data/ui-tree.json.d.ts'
import type { ToggleGroup } from './data/toggle-rules.json.d.ts'
import type { InvalidationRule } from './data/invalidation-map.json.d.ts'
import type { PrinterData, PrinterRow, PrinterEntry } from './data/printers.json.d.ts'

export type { ConfigOption, UIPage, ToggleGroup, InvalidationRule, PrinterData, PrinterRow, PrinterEntry }

/** The 907 option definitions */
export const schema: Record<string, ConfigOption>
/** Builder name -> page tree */
export const uiTree: Record<string, UIPage[]>
/** Group name -> enable_if rules */
export const toggleRules: Record<string, ToggleGroup>
/** Setting key change -> invalidated steps */
export const invalidationMap: Record<string, InvalidationRule[]>
/** Machine limits per printer, from the upstream vendor profiles */
export const printers: PrinterData
