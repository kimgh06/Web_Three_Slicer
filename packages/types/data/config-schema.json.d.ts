// three-slicer/data/config-schema.json — OrcaSlicer 원본에서 추출한 907개 옵션 정의.
// ponytail: 값을 리터럴로 좁히지 않는다. 907키 × 33필드를 리터럴로 추론시키면 소비자 tsc 가 기어간다.
//   키 단위 정확도가 필요하면 SlicerSettings(three-slicer/settings) 쪽을 쓸 것.

/** 원본 ConfigOptionDef 의 coXxx 타입 태그 */
export type ConfigOptionType =
  | 'coBool' | 'coBools'
  | 'coInt' | 'coInts'
  | 'coFloat' | 'coFloats'
  | 'coPercent' | 'coPercents'
  | 'coFloatOrPercent' | 'coFloatsOrPercents'
  | 'coString' | 'coStrings'
  | 'coEnum' | 'coEnums'
  | 'coPoint' | 'coPoints' | 'coPointsGroups'

/** 907키 중 `type` 과 `defined_in` 만 전부 존재한다. 나머지는 전부 optional. */
export interface ConfigOption {
  type: ConfigOptionType
  /** 추출된 원본 함수명 (예: 'init_common_params') */
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
