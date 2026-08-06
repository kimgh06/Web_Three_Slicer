// three-slicer/components
import type * as React from 'react'
import type { SlicerSettings } from './settings-keys.d.ts'

export interface SettingsPanelProps {
  /** sparse 맵 — 편집한 키만. 없는 키는 config-schema default 가 쓰인다. */
  settings: SlicerSettings
  /** React setState 형태. 상태가 컴포넌트 밖으로 나가는 유일한 통로. */
  setSettings: React.Dispatch<React.SetStateAction<SlicerSettings>>
  /** 라벨 클릭 — 딥링크/상세용. 생략하면 평범한 라벨(라우터 결합 0). */
  onOptionOpen?: (optKey: string) => void
  /** 다른 패널 안에 끼워 넣을 때 */
  embedded?: boolean
  /** 스키마 구동 위젯을 키 단위로 교체 (예: `{ printable_area: MyBedEditor }`) */
  customWidgets?: Record<string, React.ComponentType<any>>
}

declare const SettingsPanel: React.FC<SettingsPanelProps>
export default SettingsPanel
