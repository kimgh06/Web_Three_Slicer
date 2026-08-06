import React from 'react'

// Stage 29-2 plate tab bar: select a plate, add one, drop the last one.
export default function PlateBar({ plateCount, selectedPlate, maxPlates, onSelect, onAdd, onDelete }) {
  return (
    <div className="plate-bar" data-testid="plate-bar" role="tablist" aria-label="Plates">
      {Array.from({ length: plateCount }, (_, i) => (
        <button key={i} role="tab" className={'plate-tab' + (i === selectedPlate ? ' on' : '')} onClick={() => onSelect(i)} title={`Select plate ${i + 1} — in Preview this switches to that plate's result`} data-testid={`plate-${i}`}>{i + 1}</button>
      ))}
      <button className="plate-add" onClick={onAdd} disabled={plateCount >= maxPlates} title="Add an empty plate (max 9) — each plate slices and exports separately" data-testid="plate-add">+</button>
      {plateCount > 1 && <button className="plate-del" onClick={onDelete} title="Delete the last plate and its slice result" data-testid="plate-del">−</button>}
    </div>
  )
}
