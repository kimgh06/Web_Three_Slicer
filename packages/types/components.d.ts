// three-slicer/components
import type * as React from 'react'
import type { SlicerSettings } from './settings-keys.d.ts'

export interface SettingsPanelProps {
  /** Sparse map — only edited keys. Missing keys fall back to the config-schema default. */
  settings: SlicerSettings
  /** React setState shape. The only channel through which state leaves the component. */
  setSettings: React.Dispatch<React.SetStateAction<SlicerSettings>>
  /** Label click — for deep links / detail views. Omit for a plain label (zero router coupling). */
  onOptionOpen?: (optKey: string) => void
  /** When embedding inside another panel */
  embedded?: boolean
  /** Replace schema-driven widgets per key (e.g. `{ printable_area: MyBedEditor }`) */
  customWidgets?: Record<string, React.ComponentType<any>>
  /**
   * Pins the panel to one builder (optionally one page) and drops the search/group/page/mode chrome, so the form
   * can be folded into another card. This is how `<Viewport/>`'s `motionPanel` slot is meant to be filled:
   *
   * ```jsx
   * <SettingsPanel settings={settings} setSettings={setSettings} embedded
   *                only={{ builder: 'TabPrinter::build_kinematics_page' }} />
   * ```
   */
  only?: { builder: string; page?: string }
}

declare const SettingsPanel: React.FC<SettingsPanelProps>
export default SettingsPanel
