import React, { useMemo, useState } from 'react'
import { Link, Outlet, useParams, useSearchParams, useNavigate } from 'react-router'
import schema from '@orca-re/data/config-schema.json'
import uiTree from '@orca-re/data/ui-tree.json'
import toggles from '@orca-re/data/toggle-rules.json'
import invalidation from '@orca-re/data/invalidation-map.json'
import Viewport from './Viewport.jsx'
import SettingsPanel from '@orca-re/components/SettingsPanel'   // 33단계 Phase 4: 분리된 독립 컴포넌트
import { settingRaw } from '@orca-re/engine/settings'
import { disabledKeys, makeCfg } from '@orca-re/engine/toggle'

// 25단계 S5.2: dirty 판정 — settings 에 값이 있고 스키마 default 와 다르면 변경됨(프리셋 시스템 전이므로 기준=default).
function isDirty(settings, key) {
  if (!settings || !(key in settings)) return false
  const d = schema[key]?.default
  const def = Array.isArray(d) ? d[0] : d
  const cur = settings[key]
  return String(cur) !== String(def ?? '')
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
        <Link className="lbl" to={`/option/${optKey}`} title="상세(딥링크)">{def?.label || def?.full_label || optKey}</Link>
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
      <Link className="lbl" to={`/option/${optKey}`}>{def?.label || def?.full_label || optKey}</Link>
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

function TabView() {
  const { builder } = useParams()
  const [sp, setSp] = useSearchParams()
  const mode = sp.get('mode') ?? 'all'
  const pages = uiTree[builder] ?? []
  const [pageIdx, setPageIdx] = useState(0)
  // 빌더가 바뀌면 페이지 인덱스를 0으로 리셋 (state가 라우트 전환에도 유지되므로)
  const [lastBuilder, setLastBuilder] = useState(builder)
  if (builder !== lastBuilder) { setLastBuilder(builder); setPageIdx(0) }
  const page = pages[Math.min(pageIdx, pages.length - 1)]
  const show = k => passesMode(k, mode)
  if (!pages.length) return <p className="muted">빌더 없음: {builder}</p>
  return (
    <div className="tab">
      <aside>
        {pages.map((p, i) => (
          <button key={p.page + i} className={i === pageIdx ? 'on' : ''} onClick={() => setPageIdx(i)}>
            {p.page}
          </button>
        ))}
        <div className="modes">
          {MODES.map(m => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setSp({ mode: m })}>{m}</button>
          ))}
        </div>
      </aside>
      <main>
        <h2>{page.page} <span className="muted">Tab.cpp:{page.line}</span></h2>
        {page.groups.map(g => {
          const opts = g.options.filter(show)
          if (!opts.length) return null
          return (
            <section key={g.group + g.line}>
              <h3>{g.group || '(무제 그룹)'} <span className="muted">:{g.line}</span></h3>
              {opts.map((k, i) => <OptionRow key={k + i} optKey={k} />)}
            </section>
          )
        })}
      </main>
    </div>
  )
}

function OptionDetail() {
  const { key } = useParams()
  const def = schema[key]
  const rules = useMemo(() =>
    Object.entries(toggles).flatMap(([fn, v]) =>
      v.rules.filter(r => r.fields.includes(key)).map(r => ({ ...r, fn }))), [key])
  const inval = useMemo(() =>
    ['Print', 'PrintObject'].flatMap(scope =>
      (invalidation[scope] ?? []).filter(b => b.keys.includes(key)).map(b => ({ ...b, scope }))), [key])
  if (!def) return <p className="muted">스키마에 없는 키: {key}</p>
  return (
    <div className="detail">
      <h2>{def.label ?? key} <code>{key}</code> <ModeBadge mode={def.mode} /></h2>
      {def.tooltip && <p className="tip">{def.tooltip}</p>}
      <h3>스키마 (PrintConfig.cpp:{def.line})</h3>
      <pre>{JSON.stringify(def, null, 2)}</pre>
      <h3>활성/비활성 규칙 ({rules.length})</h3>
      {rules.length === 0 ? <p className="muted">없음 — 항상 활성</p> : (
        <ul>{rules.map((r, i) => <li key={i}><code>{r.enable_if}</code> <span className="muted">({r.fn}:{r.line})</span></li>)}</ul>
      )}
      <h3>변경 시 재실행 단계 ({inval.length})</h3>
      {inval.length === 0 ? <p className="muted">매핑 없음 → 전체 무효화(기본 분기)</p> : (
        <ul>{inval.map((b, i) => <li key={i}><b>{b.scope}</b>: {b.steps.join(', ') || b.special.join(', ')} <span className="muted">:{b.line}</span></li>)}</ul>
      )}
    </div>
  )
}

function Search() {
  const [sp] = useSearchParams()
  const q = (sp.get('q') ?? '').toLowerCase()
  const hits = useMemo(() => {
    if (!q) return []
    return Object.entries(schema)
      .filter(([k, d]) => k.includes(q) || d.label?.toLowerCase().includes(q) || d.tooltip?.toLowerCase().includes(q))
      .slice(0, 100)
  }, [q])
  return (
    <div className="detail">
      <h2>검색: “{q}” — {hits.length}건{hits.length === 100 ? '+' : ''}</h2>
      {hits.map(([k]) => <OptionRow key={k} optKey={k} />)}
    </div>
  )
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
        processPanel={<SettingsPanel settings={settings} setSettings={setSettings}
          onOptionOpen={key => navigate(`/option/${key}`)} />} />
    </div>
  )
}

export const routes = [{
  path: '/',
  element: <Layout />,
  children: [
    { index: true, element: <Prepare /> },
    { path: 'tab/:builder', element: <TabView /> },
    { path: 'option/:key', element: <OptionDetail /> },
    { path: 'search', element: <Search /> },
  ],
}]
