// three-slicer/data — the 4 extracted JSON files. Prefer this over importing the raw JSON:
// the import attribute (`with { type: 'json' }`) is already applied, so it works in Node and bundlers alike.
import type { ConfigOption } from './data/config-schema.json.d.ts'
import type { UIPage } from './data/ui-tree.json.d.ts'
import type { ToggleGroup } from './data/toggle-rules.json.d.ts'
import type { InvalidationRule } from './data/invalidation-map.json.d.ts'

export type { ConfigOption, UIPage, ToggleGroup, InvalidationRule }

/** The 907 option definitions */
export const schema: Record<string, ConfigOption>
/** Builder name -> page tree */
export const uiTree: Record<string, UIPage[]>
/** Group name -> enable_if rules */
export const toggleRules: Record<string, ToggleGroup>
/** Setting key change -> invalidated steps */
export const invalidationMap: Record<string, InvalidationRule[]>
