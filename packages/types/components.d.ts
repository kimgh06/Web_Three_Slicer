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
}

declare const SettingsPanel: React.FC<SettingsPanelProps>
export default SettingsPanel
