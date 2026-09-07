// three-slicer/viewer — the permissive viewer (three-slicer-viewer, MIT) with the kernel plugged in.
export * from 'three-slicer-viewer'
import type { ViewportProps, SlicerHandle } from 'three-slicer-viewer'
/** The permissive `useSlicer` bound to the WASM kernel worker (three-slicer/client's makeSlicerWorker). */
export function useSlicer(deps: Record<string, unknown>): SlicerHandle
declare function Viewport(props: ViewportProps): JSX.Element
export default Viewport
