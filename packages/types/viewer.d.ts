// three-slicer/viewer
import type * as React from 'react'
import type { SlicerSettings } from './settings-keys.d.ts'

export interface ViewportProps {
  /** sparse 설정 맵. 기본 `{}`. */
  settings?: SlicerSettings
  /** React setState 형태. 기본 no-op. */
  setSettings?: React.Dispatch<React.SetStateAction<SlicerSettings>>
  /** 좌측 프로세스 패널 슬롯 — 보통 `<SettingsPanel embedded/>`. 기본 null. */
  processPanel?: React.ReactNode
}

declare const Viewport: React.FC<ViewportProps>
export default Viewport
