// printable_area 전용 커스텀 에디터 — 원본 BedShapeDialog(Rectangular/Circular/Custom)의 웹 등가물.
// 어떤 모드든 출력은 항상 꼭짓점 배열(coPoints)이라 하류(엔진 bed 유도·플레이트 렌더)는 무변경.
//  · 사각형: 폭×깊이 + 원점(rect_size/rect_origin 상당)
//  · 원형: 지름 → 32각형 근사(원본 BedShapePanel 방식)
//  · 커스텀: 좌표 JSON 직접 입력
import React, { useEffect, useState } from 'react'

const rectPts = (w, d, ox, oy) => [[ox, oy], [w + ox, oy], [w + ox, d + oy], [ox, d + oy]]
const circlePts = (dia) => {
  const r = dia / 2, n = 32
  return Array.from({ length: n }, (_, i) => {
    const a = 2 * Math.PI * i / n
    return [+(r + r * Math.cos(a)).toFixed(2), +(r + r * Math.sin(a)).toFixed(2)]
  })
}
const bbox = (pts) => {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) }
}

export default function BedShapeEditor({ value, onChange, disabled }) {
  const pts = Array.isArray(value) && value.length >= 3 ? value : rectPts(200, 200, 0, 0)
  const b = bbox(pts)
  const [mode, setMode] = useState(pts.length === 4 ? 'rect' : pts.length >= 12 ? 'circle' : 'custom')
  const [rect, setRect] = useState({ w: b.w, d: b.d, ox: b.x0, oy: b.y0 })
  const [dia, setDia] = useState(Math.round(b.w))
  const [json, setJson] = useState(JSON.stringify(pts))
  const [jsonErr, setJsonErr] = useState(false)
  // 외부 리셋(값 삭제 → 기본값 복귀) 동기화
  useEffect(() => {
    const nb = bbox(pts)
    setRect({ w: nb.w, d: nb.d, ox: nb.x0, oy: nb.y0 }); setDia(Math.round(nb.w)); setJson(JSON.stringify(pts)); setJsonErr(false)
  }, [JSON.stringify(value)])  // eslint-disable-line react-hooks/exhaustive-deps

  const commitRect = (next) => { setRect(next); const { w, d, ox, oy } = next; if (w > 0 && d > 0) onChange(rectPts(w, d, ox, oy)) }
  const commitDia = (v) => { setDia(v); if (v > 0) onChange(circlePts(v)) }
  const commitJson = (t) => {
    setJson(t)
    try {
      const p = JSON.parse(t)
      if (!Array.isArray(p) || p.length < 3 || !p.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) throw 0
      setJsonErr(false); onChange(p)
    } catch { setJsonErr(true) }
  }
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

  return (
    <div className="bse" data-testid="bed-shape-editor">
      <div className="bse-modes">
        {[['rect', '사각형'], ['circle', '원형'], ['custom', '커스텀']].map(([k, l]) => (
          <button key={k} type="button" className={mode === k ? 'on' : ''} disabled={disabled} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
      {mode === 'rect' && (
        <div className="bse-grid">
          <label>폭 <input type="number" min="1" value={rect.w} disabled={disabled} data-testid="bed-w"
            onChange={e => commitRect({ ...rect, w: num(e.target.value) })} /> mm</label>
          <label>깊이 <input type="number" min="1" value={rect.d} disabled={disabled} data-testid="bed-d"
            onChange={e => commitRect({ ...rect, d: num(e.target.value) })} /> mm</label>
          <label>원점 X <input type="number" value={rect.ox} disabled={disabled}
            onChange={e => commitRect({ ...rect, ox: num(e.target.value) })} /></label>
          <label>원점 Y <input type="number" value={rect.oy} disabled={disabled}
            onChange={e => commitRect({ ...rect, oy: num(e.target.value) })} /></label>
        </div>
      )}
      {mode === 'circle' && (
        <div className="bse-grid">
          <label>지름 <input type="number" min="1" value={dia} disabled={disabled} data-testid="bed-dia"
            onChange={e => commitDia(num(e.target.value))} /> mm</label>
        </div>
      )}
      {mode === 'custom' && (
        <textarea className={'bse-json' + (jsonErr ? ' err' : '')} rows={3} value={json} disabled={disabled}
          data-testid="bed-json" onChange={e => commitJson(e.target.value)} placeholder='[[0,0],[200,0],[200,200],[0,200]]' />
      )}
    </div>
  )
}
