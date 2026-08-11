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
  /**
   * Per-panel visibility. Every panel is visible unless its key is explicitly `false`, so a host only opts out —
   * and a panel added in a later version does not disappear for hosts that listed the ones they wanted.
   */
  panels?: Partial<Record<ViewportPanel, boolean>>
  /**
   * G-code text to render instead of a slice result. Parsed into the same layer stream the kernel produces and
   * shown on the selected plate; the kernel is never started. While it is set, auto re-slice leaves that plate alone.
   */
  gcode?: string | null
  /** Initial filament colours (hex), one per extruder. Defaults to the built-in T1/T2 pair. */
  defaultExtruderColors?: string[] | null
  /**
   * Start with auto re-slice on. Unlike the in-app toggle's original behaviour this also performs the FIRST slice,
   * which is what makes a panel-less embed able to slice at all.
   */
  defaultAutoSlice?: boolean
  /** Every value change in one channel. See {@link ViewportEvent}. */
  onEvent?: (event: ViewportEvent) => void
  /** A finished slice, fired where the result is cached — switching plate tabs does not re-fire it. */
  onSliced?: (result: { plate: number; stats: Record<string, unknown>; gcode: string }) => void
}

/** Panel keys accepted by {@link ViewportProps.panels}. `sidebar: false` hides the whole right column at once. */
export type ViewportPanel =
  | 'topBar' | 'gizmoRail' | 'objectToolbar' | 'paintPanel' | 'statsCard' | 'plateBar' | 'emptyHint' | 'status'
  | 'sidebar' | 'printerCard' | 'filamentCard' | 'objectList' | 'previewControls' | 'processCard' | 'sliceBar'

/** Value changes reported through {@link ViewportProps.onEvent}. Not fired for the initial values. */
export type ViewportEvent =
  | { type: 'canvasMode'; value: 'prepare' | 'preview' }
  | { type: 'objects'; value: Array<{ id: number; name: string; extruder: number; visible: boolean }> }
  | { type: 'selectedPlate'; value: number }
  | { type: 'plateCount'; value: number }
  | { type: 'extruderColors'; value: string[] }
  | { type: 'autoSlice'; value: boolean }
  | { type: 'slicing'; value: boolean }
  /** 0..1. Fires several times a second while slicing — throttle on the host side if that matters. */
  | { type: 'progress'; value: number }
  | { type: 'viewType'; value: 'feature' | 'speed' | 'height' | 'width' | 'fan' | 'temp' | 'filament' }
  | { type: 'paintMode'; value: 'off' | 'enforcer' | 'blocker' | 'material' }
  | { type: 'layerCount'; value: number }
  | { type: 'layerRange'; value: { lo: number; hi: number } }
  | { type: 'error'; value: string }
  | { type: 'notice'; value: string }

declare const Viewport: React.FC<ViewportProps>
export default Viewport
