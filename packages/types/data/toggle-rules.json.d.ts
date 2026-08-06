// three-slicer/data/toggle-rules.json — 원본 toggle_options() 의 enable_if 조건식 추출.
// 최상위 키 = 그룹명(예: 'toggle_print_fff_options', 'TabPrinter::toggle_options').

export interface ToggleRule {
  /** 원본 C++ 조건식 문자열. 평가는 three-slicer/toggle 의 evalEnableIf. */
  enable_if?: string
  /** 이 조건이 지배하는 config-schema 키들 */
  fields?: string[]
  line?: number
}

export interface ToggleGroup {
  /** 로컬 변수명 → 원본 C++ 표현식(문자열). 번역은 toggle_eval.js 가 하드코딩으로 한다. */
  locals: Record<string, string>
  rules: ToggleRule[]
  stats?: { toggle_calls_in_source: number; rules_extracted: number }
}

declare const toggles: Record<string, ToggleGroup>
export default toggles
