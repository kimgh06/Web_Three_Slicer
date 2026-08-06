// three-slicer/data/ui-tree.json — 원본 Tab.cpp 의 페이지/그룹 트리.
// 최상위 키 = 빌더명(예: 'TabPrint::build'), 값 = 그 빌더가 만드는 페이지들.

export interface UIGroup {
  group: string
  line?: number
  /** config-schema 의 옵션 키들 */
  options: string[]
}

export interface UIPage {
  page: string
  icon?: string
  line?: number
  groups: UIGroup[]
}

declare const uiTree: Record<string, UIPage[]>
export default uiTree
