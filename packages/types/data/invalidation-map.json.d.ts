// three-slicer/data/invalidation-map.json — 설정 키 변경 → 무효화되는 슬라이스 단계.
// 최상위 키 = 무효화 대상 종류(print/object/filament 등).

export interface InvalidationRule {
  /** 이 규칙이 반응하는 config-schema 키들 */
  keys: string[]
  /** 무효화되는 단계 (예: 'psSkirtBrim', 'posSlice') */
  steps: string[]
  /** 단계로 표현 안 되는 특수 처리 */
  special: string[]
  line?: number
}

declare const invalidationMap: Record<string, InvalidationRule[]>
export default invalidationMap
