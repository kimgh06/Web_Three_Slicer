// three-slicer/data — 추출 JSON 4종. 원본 JSON 을 직접 import 하는 것보다 이쪽을 권한다:
// import attribute(`with { type: 'json' }`)가 이미 붙어 있어 Node·번들러 양쪽에서 그대로 돌아간다.
import type { ConfigOption } from './data/config-schema.json.d.ts'
import type { UIPage } from './data/ui-tree.json.d.ts'
import type { ToggleGroup } from './data/toggle-rules.json.d.ts'
import type { InvalidationRule } from './data/invalidation-map.json.d.ts'

export type { ConfigOption, UIPage, ToggleGroup, InvalidationRule }

/** 907개 옵션 정의 */
export const schema: Record<string, ConfigOption>
/** 빌더명 → 페이지 트리 */
export const uiTree: Record<string, UIPage[]>
/** 그룹명 → enable_if 규칙 */
export const toggleRules: Record<string, ToggleGroup>
/** 설정 키 변경 → 무효화 단계 */
export const invalidationMap: Record<string, InvalidationRule[]>
