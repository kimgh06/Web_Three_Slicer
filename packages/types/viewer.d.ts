// three-slicer/viewer
import type * as React from 'react'
import type { SlicerSettings } from './settings-keys.d.ts'

export interface ViewportProps {
  /** Sparse settings map. Defaults to `{}`. */
  settings?: SlicerSettings
  /** React setState shape. Defaults to a no-op. */
  setSettings?: React.Dispatch<React.SetStateAction<SlicerSettings>>
  /** Left process-panel slot — usually `<SettingsPanel embedded/>`. Defaults to null. */
  processPanel?: React.ReactNode
}

declare const Viewport: React.FC<ViewportProps>
export default Viewport
