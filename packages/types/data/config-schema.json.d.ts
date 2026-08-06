// three-slicer/data/config-schema.json — the 907 option definitions extracted from upstream OrcaSlicer.
// ponytail: values are not narrowed to literals. Inferring 907 keys x 33 fields as literals crawls in consumer tsc.
//   Use SlicerSettings (three-slicer/settings) when you need per-key accuracy.

/** The coXxx type tag from the upstream ConfigOptionDef */
export type ConfigOptionType =
  | 'coBool' | 'coBools'
  | 'coInt' | 'coInts'
  | 'coFloat' | 'coFloats'
  | 'coPercent' | 'coPercents'
  | 'coFloatOrPercent' | 'coFloatsOrPercents'
  | 'coString' | 'coStrings'
  | 'coEnum' | 'coEnums'
  | 'coPoint' | 'coPoints' | 'coPointsGroups'

/** Of the 907 keys, only `type` and `defined_in` always exist. Everything else is optional. */
export interface ConfigOption {
  type: ConfigOptionType
  /** Name of the source function it was extracted from (e.g. 'init_common_params') */
  defined_in: string
  line?: number
  mode?: string
  label?: string
  full_label?: string
  tooltip?: string
  sidetext?: string
  category?: string
  default?: unknown
  default_type?: string
  default_raw?: string
  enum_type?: string
  enum_values?: string[]
  enum_labels?: string[]
  enum_values_copied_from?: string
  enum_labels_copied_from?: string
  min?: number
  max?: number
  max_literal?: unknown
  gui_type?: string
  gui_flags?: string
  ratio_over?: string
  nullable?: boolean
  readonly?: boolean
  multiline?: boolean
  full_width?: boolean
  height?: number
  cli?: string
  cli_params?: string
  aliases?: string[]
  plugin_type?: string
  generated_by_loop?: unknown
}

declare const schema: Record<string, ConfigOption>
export default schema
