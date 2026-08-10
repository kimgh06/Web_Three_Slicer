import React from 'react'
import { splitIcon, eyeIcon, eyeSlashIcon, deleteIcon } from '../icons.js'

// Object list card: print toggle, name, extruder selector, split and delete, plus the two slice toggles.
export default function ObjectList({
  objects, extruderColors, onToggleVisible, onExtruder, onSplit, onRemove,
  supportOn, onToggleSupport, wipeTowerReal, onToggleWipeTower,
  overhangOn, onToggleOverhang, overhangAngle, paintMode, onTogglePaint,
  supportStyle, supportStyles, onSupportStyle,
}) {
  return (
    <section className="side-card" data-testid="object-section">
      <div className="sc-head">📦 Objects <span className="sc-count">{objects.length}</span></div>
      <ul className="obj-list2" data-testid="obj-list">
        {objects.map(o => (
          <li key={o.id} className={o.visible === false ? 'obj-hidden' : ''}>
            <button className="obj-eye" onClick={() => onToggleVisible(o.id)} title="Include/exclude this object from printing — excluding it keeps it in the scene" data-testid={`eye-${o.id}`}>
              <img src={o.visible === false ? eyeSlashIcon : eyeIcon} alt={o.visible === false ? 'Hidden' : 'Visible'} />
            </button>
            <span className="obj-name" title={o.name}>{o.name}</span>
            <select className="obj-ext" value={o.extruder ?? 1} onChange={e => onExtruder(o.id, +e.target.value)} title="Which filament (extruder) prints this object" data-testid={`ext-${o.id}`}>
              {extruderColors.map((c, i) => <option key={i} value={i + 1}>T{i + 1}</option>)}
            </select>
            <button className="obj-split" onClick={() => onSplit(o.id)} title="Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)" data-testid={`split-${o.id}`}><img src={splitIcon} alt="Split" /></button>
            <button className="obj-del" onClick={() => onRemove(o.id)} title="Remove this object from the scene"><img src={deleteIcon} alt="Delete" /></button>
          </li>
        ))}
      </ul>
      <label className="slice-support"><input type="checkbox" checked={supportOn} onChange={onToggleSupport} title="Generate support structures under overhangs (same as enable_support in the settings panel)" data-testid="support-toggle" /> Generate support</label>
      {/* The two things you actually do about support — see where it is needed, and brush it — used to live only
          on the left gizmo rail, with nothing here to hint they existed. */}
      {supportOn && (
        <div className="sc-info sup-style"><span>Style</span>
          <select className="sc-model" value={supportStyle} onChange={e => onSupportStyle(e.target.value)}
            data-testid="support-style"
            title="Support style (support_style). The kernel builds the tree/organic family as real tree support; the rest as grid.">
            {supportStyles.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      {supportOn && (
        <div className="support-tools">
          <label className="slice-support">
            <input type="checkbox" checked={!!overhangOn} onChange={onToggleOverhang}
              title={`Shade the facets that will need support (slope below ${overhangAngle}°, the support threshold angle)`}
              data-testid="overhang-toggle" /> Show overhangs <span className="muted">&lt;{overhangAngle}°</span>
          </label>
          <button className={paintMode !== 'off' ? 'sup-paint on' : 'sup-paint'} onClick={onTogglePaint}
            disabled={!objects.length} data-testid="support-paint-btn"
            title="Brush facets to force or block support — the same tool as the paint icon on the left rail">
            {paintMode !== 'off' ? 'Painting…' : 'Paint support'}
          </button>
        </div>
      )}
      <label className="slice-support"><input type="checkbox" checked={wipeTowerReal} onChange={onToggleWipeTower} title="Use the upstream WipeTower to compute purge volumes on multi-material tool changes (off = a simple square ring)" data-testid="wipe-tower-real-toggle" /> Real wipe tower <span className="muted">(MM)</span></label>
    </section>
  )
}
