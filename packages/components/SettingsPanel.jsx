import React from 'react'
import Core from 'three-slicer-viewer/components'
import { schema, uiTree } from 'three-slicer/data'
import { makeCfg, disabledKeys } from 'three-slicer/toggle'

// three-slicer/components: the permissive settings panel with upstream's data plugged in. The component is
// three-slicer-viewer's (MIT); what this package adds is the full config schema (labels and tooltips are
// OrcaSlicer's text), the real tab/page/group tree, and the toggle evaluator bound to upstream's rules.
const toggle = { makeCfg, disabledKeys }
export { schema, uiTree, toggle }

export default function SettingsPanel(props) {
  return <Core schema={schema} uiTree={uiTree} toggle={toggle} {...props} />
}
