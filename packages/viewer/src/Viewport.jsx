import React from 'react'
import Core, { useSlicer as useCoreSlicer } from 'three-slicer-viewer'
import { makeSlicerWorker } from 'three-slicer/client'
import { bundledCatalog } from 'three-slicer/settings'

// three-slicer/viewer: the permissive viewer with the kernel plugged in. Everything React here is
// three-slicer-viewer (MIT). What this package adds is the two things that cannot be permissive — the WASM
// kernel worker (three-slicer/client's makeSlicerWorker) and the bundled vendor catalog (three-slicer/settings'
// bundledCatalog) — and this binding of them. A host composing by hand imports those two from where they live.
/** The permissive `useSlicer` bound to the WASM kernel worker. Stable, so it may be handed to `<Viewport slicer>`. */
export const useSlicer = (deps) => useCoreSlicer({ ...deps, makeWorker: makeSlicerWorker })

export default function Viewport({ slicer, catalog, ...props }) {
  // `catalog === undefined` keeps the pre-split meaning: nothing passed means the bundled presets. `null` is
  //  still "no presets", which the permissive viewer treats the same way.
  return <Core {...props} slicer={slicer ?? useSlicer} catalog={catalog === undefined ? bundledCatalog : catalog} />
}
