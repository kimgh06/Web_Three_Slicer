import React from 'react'
import { moveIcon, rotateIcon, scaleIcon, paintIcon } from '../icons.js'

// S3 left rail: the transform gizmos plus the support painting mode.
export default function GizmoRail({ gizmoMode, paintMode, onGizmo, onTogglePaint }) {
  const active = (mode) => (gizmoMode === mode && paintMode === 'off' ? 'on' : '')
  return (
    <nav className="left-rail" role="toolbar" aria-label="Gizmo tools">
      <button className={active('translate')} onClick={() => onGizmo('translate')} title="Move the object — drag a gizmo axis or use arrow keys for 10mm (Shift 1mm) (M/G)" data-testid="gizmo-move"><img src={moveIcon} alt="Move" /></button>
      <button className={active('rotate')} onClick={() => onGizmo('rotate')} title="Rotate the object — PageUp/PageDown rotates in 45° steps (R)" data-testid="gizmo-rotate"><img src={rotateIcon} alt="Rotate" /></button>
      <button className={active('scale')} onClick={() => onGizmo('scale')} title="Scale the object (S)" data-testid="gizmo-scale"><img src={scaleIcon} alt="Scale" /></button>
      <div className="rail-sep" />
      <button className={paintMode !== 'off' ? 'on' : ''} onClick={onTogglePaint} title="Brush facets to enforce or block support — the wheel changes the brush size" data-testid="gizmo-paint"><img src={paintIcon} alt="Support painting" /></button>
    </nav>
  )
}
