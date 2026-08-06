import React from 'react'

// Filament card: one row per extruder color. The colors feed the object meshes and the prime tower.
export default function FilamentCard({ colors, onColor, onAdd, onRemove }) {
  return (
    <section className="side-card" data-testid="filament-section">
      <div className="sc-head">🧵 Filament <span className="sc-count">{colors.length}</span>
        <span className="sc-head-btns">
          <button onClick={onAdd} disabled={colors.length >= 4} title="Add a filament (extruder) — up to 4, assignable per object" data-testid="filament-add">+</button>
          <button onClick={onRemove} disabled={colors.length <= 1} title="Remove the last filament — objects using it are reassigned to a remaining number" data-testid="filament-del">−</button>
        </span>
      </div>
      {colors.map((c, i) => (
        <div className="filament-row" key={i}>
          <input type="color" value={c} onChange={e => onColor(i, e.target.value)} title={`T${i + 1} filament color`} data-testid={`filament-color-${i}`} />
          <span className="fil-t">T{i + 1}</span>
          <span className="fil-swatch" style={{ background: c }} />
          <span className="fil-hex muted">{c}</span>
        </div>
      ))}
    </section>
  )
}
