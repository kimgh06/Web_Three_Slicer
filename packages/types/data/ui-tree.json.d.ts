// three-slicer/data/ui-tree.json — the page/group tree from upstream Tab.cpp.
// Top-level key = builder name (e.g. 'TabPrint::build'), value = the pages that builder creates.

export interface UIGroup {
  group: string
  line?: number
  /** The config-schema option keys */
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
