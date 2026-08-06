// three-slicer/data/invalidation-map.json — setting key change -> invalidated slice steps.
// Top-level key = the kind of invalidation target (print/object/filament, etc.).

export interface InvalidationRule {
  /** The config-schema keys this rule reacts to */
  keys: string[]
  /** The invalidated steps (e.g. 'psSkirtBrim', 'posSlice') */
  steps: string[]
  /** Special handling that cannot be expressed as a step */
  special: string[]
  line?: number
}

declare const invalidationMap: Record<string, InvalidationRule[]>
export default invalidationMap
