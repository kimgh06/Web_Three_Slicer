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
   *
   * A {@link LockablePanel} also accepts `'readonly'`: the panel is drawn but nothing inside it can be clicked,
   * typed into or tabbed to — including any node the host passed into it. That is the shape a host wants when it
   * presets the printer, process and filament itself and does not want the user changing them.
   *
   * Note what it locks: the UI path, not the value. `settings` is still the host's own prop, and other paths
   * inside the viewer still write it — importing a 3mf project applies that project's settings either way.
   */
  panels?: Partial<Record<ViewportPanel, boolean>> & Partial<Record<LockablePanel, boolean | 'readonly'>>
  /**
   * Behaviour switches, following the same opt-out rule as {@link ViewportProps.panels}: everything is on unless
   * its key is explicitly `false`. These are the things the component does *outside* its own box — take the page's
   * keyboard, load the WASM kernel, write to the console — which a host embedding it in a larger app may already
   * be doing itself. See {@link ViewportFeature}.
   */
  features?: Partial<Record<ViewportFeature, boolean>>
  /**
   * Intercepts every file the viewer would otherwise hand to the browser as a download — the 3mf project, the STL,
   * and each plate's G-code. Return anything truthy to say it is handled and suppress the download; return nothing
   * to let it proceed as well. This is the only way in: the save buttons live inside the component.
   *
   * ```jsx
   * <Viewport onExport={(blob, filename) => { upload(blob, filename); return true }} />
   * ```
   */
  onExport?: (file: Blob, filename: string) => boolean | void
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

/**
 * Behaviour keys accepted by {@link ViewportProps.features}. All default to enabled.
 *
 * - `shortcuts` — the keyboard bindings. They are installed on `window`, so while the viewer is mounted they fire
 *   wherever focus is (except inside inputs) and `Ctrl+C` in particular preventDefaults. Turn them off when the
 *   host page has its own.
 * - `warmup` — loading the WASM kernel on mount, ahead of the first slice. Off, nothing is downloaded or compiled
 *   until something actually slices — which for a `gcode`-only viewer is never.
 * - `drop` — drag and drop onto the canvas.
 * - `filePicker` — the file dialog, from every button that opens it.
 * - `contextMenu` — the right-click menu. Note that the browser's own menu stays suppressed over the canvas either
 *   way: OrbitControls preventDefaults `contextmenu` itself.
 * - `logs` — console diagnostics, from the component and from the slice worker.
 */
export type ViewportFeature = 'shortcuts' | 'warmup' | 'drop' | 'filePicker' | 'contextMenu' | 'logs'

/**
 * The panels that accept `'readonly'` as well as `true`/`false` — the right column and the cards in it. Everything
 * else takes a boolean only: locking the gizmo rail or the plate tabs is what `features` and `panels: false` are
 * for, and pretending otherwise would mean a `'readonly'` that silently does nothing on half the keys.
 *
 * `sidebar: 'readonly'` locks the whole column in one go, so the per-card keys are for mixing — a locked printer
 * card above a live object list, say.
 */
export type LockablePanel =
  | 'sidebar' | 'printerCard' | 'filamentCard' | 'objectList' | 'towerCard'
  | 'previewControls' | 'processCard' | 'sliceBar'

/** Panel keys accepted by {@link ViewportProps.panels}. `sidebar: false` hides the whole right column at once. */
export type ViewportPanel =
  | 'topBar' | 'gizmoRail' | 'objectToolbar' | 'paintPanel' | 'statsCard' | 'plateBar' | 'emptyHint' | 'status'
  | 'sidebar' | 'printerCard' | 'filamentCard' | 'objectList' | 'previewControls' | 'processCard' | 'sliceBar'
  /** The horizontal move scrub under the canvas — how far into the top shown layer the print has got. Preview
   *  and FFF only: a resin layer is cured in one exposure and has no intra-layer order to walk. */
  | 'moveBar'
  /** The over-the-bed warning, shown in Prepare when something leaves the printable area. */
  | 'bedWarn'
  /** The prime tower card. Only rendered anyway once a second filament exists. */
  | 'towerCard'
  /** The resin (SLA) card. Takes the filament card's place when the printer profile declares SLA. */
  | 'resinCard'

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
  /** The move scrub's position within the top shown layer; `max` is that layer's move count, extrusions and
   *  travels together. Not fired while the whole layer is shown. */
  | { type: 'moveScrub'; value: { at: number; max: number } }
  | { type: 'error'; value: string }
  | { type: 'notice'; value: string }

declare const Viewport: React.FC<ViewportProps>
export default Viewport
