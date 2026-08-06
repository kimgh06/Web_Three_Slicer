import React, { useMemo, useState } from 'react'
import { Link, Outlet, useParams, useSearchParams, useNavigate } from 'react-router'
import schema from 'three-slicer/data/config-schema.json'
import uiTree from 'three-slicer/data/ui-tree.json'
import toggles from 'three-slicer/data/toggle-rules.json'
import invalidation from 'three-slicer/data/invalidation-map.json'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'   // 33단계 Phase 4: 분리된 독립 컴포넌트
import { settingRaw } from 'three-slicer/settings'
import { disabledKeys, makeCfg } from 'three-slicer/toggle'
import Landing from './Landing.jsx'

// 25단계 S5.2: dirty 판정 — settings 에 값이 있고 스키마 default 와 다르면 변경됨(프리셋 시스템 전이므로 기준=default).
function isDirty(settings, key) {
  if (!settings || !(key in settings)) return false
  const keyDefault = schema[key]?.default
  const def = Array.isArray(keyDefault) ? keyDefault[0] : keyDefault
  const current = settings[key]
  return String(current) !== String(def ?? '')
}

const MAIN_BUILDERS = Object.keys(uiTree).filter(b => uiTree[b].length > 0)
const MODES = ['all', 'simple', 'advanced', 'expert', 'develop']

// mode 필터: 옵션 키가 현재 mode 필터를 통과하는가 (TabView·SettingsPanel 공용)
function passesMode(k, mode) {
  if (mode === 'all' || k.startsWith('<')) return true
  const m = schema[k]?.mode
  if (mode === 'simple') return m === 'simple'
  if (mode === 'advanced') return m === 'simple' || m === 'advanced'
  return true // expert/develop = 전부
}

const builderLabel = b => b.replace('::build', '').replace('Tab', '')

function widgetFor(def) {
  if (!def) return 'unknown'
  if (def.gui_type === 'color') return 'color'
  if (def.enum_values) return 'select'
  if (def.type === 'coBool' || def.type === 'coBools') return 'checkbox'
  if (def.multiline || def.is_code) return 'textarea'
  if (def.type === 'coPoints' || def.type === 'coPoint') return 'points'
  return 'input'
}

function Widget({ def }) {
  const kind = widgetFor(def)
  const dflt = def?.default
  switch (kind) {
    case 'select':
      return (
        <select defaultValue={Array.isArray(dflt) ? dflt[0] : dflt} disabled>
          {def.enum_values.map((v, i) => (
            <option key={v} value={v}>{def.enum_labels?.[i] ?? v}</option>
          ))}
        </select>
      )
    case 'checkbox':
      return <input type="checkbox" defaultChecked={Array.isArray(dflt) ? !!dflt[0] : !!dflt} disabled />
    case 'color':
      return <input type="color" defaultValue={typeof dflt === 'string' && dflt.startsWith('#') ? dflt : '#00ae42'} disabled />
    case 'textarea':
      return <textarea rows={2} defaultValue={Array.isArray(dflt) ? dflt.join('\n') : dflt ?? ''} readOnly />
    case 'points':
      return <code className="pts">{JSON.stringify(dflt ?? [])}</code>
    case 'unknown':
      return <span className="muted">스키마 없음</span>
    default:
      return (
        <span className="inputwrap">
          <input defaultValue={Array.isArray(dflt) ? dflt.join(', ') : dflt ?? ''} readOnly />
          {def.sidetext && <span className="unit">{def.sidetext}</span>}
        </span>
      )
  }
}

function ModeBadge({ mode }) {
  return <span className={`badge mode-${mode ?? 'none'}`}>{mode ?? '—'}</span>
}

// 편집 가능 위젯 — 값은 settings 맵(없으면 스키마 default), 변경 시 setSettings.
// 벡터형(coFloats 등)은 첫 원소만 편집(단순화).
function EditableWidget({ def, optKey, settings, setSettings, disabled }) {
  const kind = widgetFor(def)
  const raw = settingRaw(settings, optKey)
  const scalar = Array.isArray(raw) ? raw[0] : raw
  const set = v => setSettings(s => ({ ...s, [optKey]: v }))
  switch (kind) {
    case 'select':
      return (
        <select value={scalar ?? ''} onChange={e => set(e.target.value)} disabled={disabled}>
          {def.enum_values.map((v, i) => <option key={v} value={v}>{def.enum_labels?.[i] ?? v}</option>)}
        </select>
      )
    case 'checkbox':
      return <input type="checkbox" checked={Array.isArray(raw) ? !!raw[0] : !!raw} onChange={e => set(e.target.checked)} disabled={disabled} />
    case 'color':
      return <input type="color" value={typeof scalar === 'string' && scalar.startsWith('#') ? scalar : '#00ae42'} onChange={e => set(e.target.value)} disabled={disabled} />
    case 'textarea':
      return <textarea rows={2} value={Array.isArray(raw) ? raw.join('\n') : (raw ?? '')} onChange={e => set(e.target.value)} disabled={disabled} />
    case 'points':
      return <code className="pts" title="좌표 편집은 이번 범위 아님">{JSON.stringify(raw ?? [])}</code>
    case 'unknown':
      return <span className="muted">스키마 없음</span>
    default:
      return (
        <span className="inputwrap">
          <input value={scalar ?? ''} onChange={e => set(e.target.value)} disabled={disabled} />
          {def.sidetext && <span className="unit">{def.sidetext}</span>}
        </span>
      )
  }
}

// disabled: {key:조건식} (S5.1 toggle-rules). settings 변경 시 dirty 점+리셋(S5.2).
function EditableOptionRow({ optKey, settings, setSettings, disabled }) {
  if (optKey.startsWith('<')) return <div className="row custom"><span className="muted">⚙ 커스텀 위젯 {optKey}</span></div>
  const def = schema[optKey]
  const cond = disabled ? disabled[optKey] : undefined       // 비활성 조건식(있으면 회색+툴팁)
  const off = cond != null
  const dirty = isDirty(settings, optKey)
  const reset = () => setSettings(s => { const n = { ...s }; delete n[optKey]; return n })
  return (
    <div className={'row' + (off ? ' disabled' : '')} title={off ? `비활성 조건: ${cond}` : (def?.tooltip ?? '')} data-testid={`row-${optKey}`}>
      <span className="lbl-cell">
        {dirty && <span className="dirty-dot" title="기본값에서 변경됨" data-testid={`dirty-${optKey}`} />}
        <Link className="lbl" to={`/slice/option/${optKey}`} title="상세(딥링크)">{def?.label || def?.full_label || optKey}</Link>
      </span>
      <code className="key">{optKey}</code>
      <ModeBadge mode={def?.mode} />
      <span className="widget-cell">
        <EditableWidget def={def} optKey={optKey} settings={settings} setSettings={setSettings} disabled={off} />
        {dirty && <button className="reset-btn" onClick={reset} title="기본값으로 리셋" data-testid={`reset-${optKey}`}>↺</button>}
      </span>
    </div>
  )
}

function OptionRow({ optKey }) {
  if (optKey.startsWith('<')) {
    return <div className="row custom"><span className="muted">⚙ 커스텀 위젯 {optKey}</span></div>
  }
  const def = schema[optKey]
  return (
    <div className="row" title={def?.tooltip ?? ''}>
      <Link className="lbl" to={`/slice/option/${optKey}`}>{def?.label || def?.full_label || optKey}</Link>
      <code className="key">{optKey}</code>
      <ModeBadge mode={def?.mode} />
      <Widget def={def} />
    </div>
  )
}

// 헤더 제거: 화면 = 3D 뷰포트 + 우측 설정 패널 전폭. (/tab /option /search 는 URL 직접 접근용으로만 유지)
function Layout() {
  return <div className="app"><Outlet /></div>
}

// 우측 설정 사이드바 — 편집 가능 + 상단 검색 input(결과는 패널 내 리스트).
// 27단계: 데스크톱형 셸은 Viewport 가 소유(상단바+좌측 기즈모 레일+중앙 뷰포트+우측 사이드바).
//  프로세스 섹션엔 설정 패널(SettingsPanel)을 processPanel 로 임베드 — 상태 공유는 그대로.
function Prepare() {
  const [settings, setSettings] = useState({})   // sparse 맵 (편집한 키만). 리로드 시 초기화.
  const navigate = useNavigate()
  return (
    <div className="prepare">
      <Viewport settings={settings} setSettings={setSettings}
        processPanel={<SettingsPanel embedded settings={settings} setSettings={setSettings}
          onOptionOpen={key => navigate(`/slice/option/${key}`)} />} />
    </div>
  )
}

// 랜딩(/)과 슬라이서(/slice)를 분리한다. 랜딩은 Layout(3D 셸) 밖에 두어
//  three.js/WASM 초기화 없이 뜨게 한다 — 소개만 보러 온 사람에게 커널을 로드시키지 않는다.
export const routes = [
  { path: '/', element: <Landing /> },
  { path: '/slice', element: <Prepare />},
]
