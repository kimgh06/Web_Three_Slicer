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
  /** Motion-limits editor, folded into the printer card — usually `<SettingsPanel only={{builder:'TabPrinter::build_kinematics_page'}}/>`. */
  motionPanel?: React.ReactNode
  /**
   * Filament editor, folded into the filament card. Pass a function rather than a node: with more than one
   * extruder loaded the card projects that extruder's slice of the per-extruder columns and writes the form's
   * edits back at its index, so the panel must bind to the pair it is given.
   */
  filamentPanel?: React.ReactNode
    | ((settings: SlicerSettings, setSettings: React.Dispatch<React.SetStateAction<SlicerSettings>>) => React.ReactNode)
}

declare const Viewport: React.FC<ViewportProps>
export default Viewport
