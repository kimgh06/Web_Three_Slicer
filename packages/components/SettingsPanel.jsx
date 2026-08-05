// @three-slicer/components — <SettingsPanel/> : config-schema-driven slicer settings form.
// Independent & props-driven: NO global state, NO React context, NO router. Depends only on React,
// @three-slicer/data (schema/ui-tree/toggle-rules), and @three-slicer/engine (settingRaw/disabledKeys/makeCfg).
// Props:
//   settings     : sparse map {optKey: value} (edited keys only; missing = schema default)
//   setSettings  : (updater) => void   (React setState-style; the ONLY way state leaves the component)
//   onOptionOpen : (optKey) => void    (optional; label click — deep-link/detail. Omit → plain labels,
//                  which is what apps/independence-check does to prove zero router coupling.)
import React, { useMemo, useState } from 'react'
import ShadowHost from './shadow_host.jsx'
import shadowCss from './styles.css?inline'   // Shadow DOM 격리 — 빌드 시 문자열로 내장
import schema from '@three-slicer/data/config-schema.json'
import uiTree from '@three-slicer/data/ui-tree.json'
import { settingRaw } from '@three-slicer/engine/settings'
import { disabledKeys, makeCfg } from '@three-slicer/engine/toggle'

const MAIN_BUILDERS = Object.keys(uiTree).filter(b => uiTree[b].length > 0)
const MODES = ['all', 'simple', 'advanced', 'expert', 'develop']
const builderLabel = b => b.replace('::build', '').replace('Tab', '')

function isDirty(settings, key) {
  if (!settings || !(key in settings)) return false
  const d = schema[key]?.default
  const def = Array.isArray(d) ? d[0] : d
  return String(settings[key]) !== String(def ?? '')
}
function passesMode(k, mode) {
  if (mode === 'all' || k.startsWith('<')) return true
  const m = schema[k]?.mode
  if (mode === 'simple') return m === 'simple'
  if (mode === 'advanced') return m === 'simple' || m === 'advanced'
  return true
}
function widgetFor(def) {
  if (!def) return 'unknown'
  if (def.gui_type === 'color') return 'color'
  if (def.enum_values) return 'select'
  if (def.type === 'coBool' || def.type === 'coBools') return 'checkbox'
  if (def.multiline || def.is_code) return 'textarea'
  if (def.type === 'coPoints' || def.type === 'coPoint') return 'points'
  return 'input'
}
function ModeBadge({ mode }) { return <span className={`badge mode-${mode ?? 'none'}`}>{mode ?? '—'}</span> }

function EditableWidget({ def, optKey, settings, setSettings, disabled }) {
  const kind = widgetFor(def)
  const raw = settingRaw(settings, optKey)
  const scalar = Array.isArray(raw) ? raw[0] : raw
  const set = v => setSettings(s => ({ ...s, [optKey]: v }))
  switch (kind) {
    case 'select':
      return (<select value={scalar ?? ''} onChange={e => set(e.target.value)} disabled={disabled}>
        {def.enum_values.map((v, i) => <option key={v} value={v}>{def.enum_labels?.[i] ?? v}</option>)}
      </select>)
    case 'checkbox':
      return <input type="checkbox" checked={Array.isArray(raw) ? !!raw[0] : !!raw} onChange={e => set(e.target.checked)} disabled={disabled} />
    case 'color':
      return <input type="color" value={typeof scalar === 'string' && scalar.startsWith('#') ? scalar : '#00ae42'} onChange={e => set(e.target.value)} disabled={disabled} />
    case 'textarea':
      return <textarea rows={2} value={Array.isArray(raw) ? raw.join('\n') : (raw ?? '')} onChange={e => set(e.target.value)} disabled={disabled} />
    case 'points':
      return <code className="pts">{JSON.stringify(raw ?? [])}</code>
    case 'unknown':
      return <span className="muted">스키마 없음</span>
    default:
      return (<span className="inputwrap">
        <input value={scalar ?? ''} onChange={e => set(e.target.value)} disabled={disabled} />
        {def.sidetext && <span className="unit">{def.sidetext}</span>}
      </span>)
  }
}

function EditableOptionRow({ optKey, settings, setSettings, disabled, onOptionOpen }) {
  if (optKey.startsWith('<')) return <div className="row custom"><span className="muted">⚙ 커스텀 위젯 {optKey}</span></div>
  const def = schema[optKey]
  const cond = disabled ? disabled[optKey] : undefined
  const off = cond != null
  const dirty = isDirty(settings, optKey)
  const reset = () => setSettings(s => { const n = { ...s }; delete n[optKey]; return n })
  const label = def?.label || def?.full_label || optKey
  return (
    <div className={'row' + (off ? ' disabled' : '')} title={off ? `비활성 조건: ${cond}` : (def?.tooltip ?? '')} data-testid={`row-${optKey}`}>
      <span className="lbl-cell">
        {dirty && <span className="dirty-dot" title="기본값에서 변경됨" data-testid={`dirty-${optKey}`} />}
        {onOptionOpen
          ? <button type="button" className="lbl lbl-link" onClick={() => onOptionOpen(optKey)} title="상세">{label}</button>
          : <span className="lbl">{label}</span>}
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

export default function SettingsPanel({ settings, setSettings, onOptionOpen, embedded = false }) {
  const [builder, setBuilder] = useState(MAIN_BUILDERS[0] ?? '')
  const [pageIdx, setPageIdx] = useState(0)
  const [mode, setMode] = useState('all')
  const [query, setQuery] = useState('')
  const pages = uiTree[builder] ?? []
  const page = pages[Math.min(pageIdx, pages.length - 1)]
  const disabled = useMemo(() => disabledKeys(makeCfg(settings)), [settings])
  const q = query.trim().toLowerCase()
  const hits = useMemo(() => {
    if (!q) return []
    return Object.entries(schema)
      .filter(([k, d]) => k.includes(q) || d.label?.toLowerCase().includes(q) || d.full_label?.toLowerCase().includes(q))
      .slice(0, 60).map(([k]) => k)
  }, [q])
  const row = (k, i) => <EditableOptionRow key={k + i} optKey={k} settings={settings} setSettings={setSettings} disabled={disabled} onOptionOpen={onOptionOpen} />
  return (
    <ShadowHost css={shadowCss} className={embedded ? 'sp-embedded' : undefined}>
    <div className="settings-panel">
      <div className="sp-top">
        <input className="sp-search" placeholder="옵션 검색 (907개)…" value={query} onChange={e => setQuery(e.target.value)} data-testid="opt-search" />
        {!q && (<>
          <label className="sp-builder"><span>설정 그룹</span>
            <select value={builder} onChange={e => { setBuilder(e.target.value); setPageIdx(0) }}>
              {MAIN_BUILDERS.map(b => <option key={b} value={b}>{builderLabel(b)}</option>)}
            </select>
          </label>
          <div className="sp-pages">
            {pages.map((p, i) => <button key={p.page + i} className={i === Math.min(pageIdx, pages.length - 1) ? 'on' : ''} onClick={() => setPageIdx(i)}>{p.page}</button>)}
          </div>
          <div className="sp-modes">
            {MODES.map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m}</button>)}
          </div>
        </>)}
      </div>
      <div className="sp-body">
        {q ? (
          <section data-testid="search-results">
            <h3>검색: “{query}” — {hits.length}건{hits.length === 60 ? '+' : ''}</h3>
            {hits.map(row)}
            {!hits.length && <p className="muted">일치 없음</p>}
          </section>
        ) : page ? (<>
          <h2>{page.page} <span className="muted">Tab.cpp:{page.line}</span></h2>
          {page.groups.map(g => {
            const opts = g.options.filter(k => passesMode(k, mode))
            if (!opts.length) return null
            return (<section key={g.group + g.line}>
              <h3>{g.group || '(무제 그룹)'} <span className="muted">:{g.line}</span></h3>
              {opts.map(row)}
            </section>)
          })}
        </>) : <p className="muted">빌더 없음</p>}
      </div>
    </div>
    </ShadowHost>
  )
}
