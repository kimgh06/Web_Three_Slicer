import React from 'react'

// Printer card: bed width x depth (rectangular, edited inline) + the nozzle diameter.
// Origin, circular and custom shapes belong to the process panel's printable_area editor.
export default function PrinterCard({ bedWidth, bedDepth, nozzleDia, onBedSize }) {
  const w = Math.round(bedWidth), d = Math.round(bedDepth)
  const blurOnEnter = (e) => { if (e.key === 'Enter') e.target.blur() }
  return (
    <section className="side-card">
      <div className="sc-head">🖨 Printer</div>
      <div className="sc-info"><span>Bed</span>
        <span className="sc-bed" title="Plate size — applied on Enter or blur. Circular/custom shapes come from the printable_area option">
          <input type="number" min="1" key={`w${w}`} defaultValue={w}
            onBlur={e => onBedSize(+e.target.value, bedDepth)}
            onKeyDown={blurOnEnter} data-testid="bed-w-card" />
          ×
          <input type="number" min="1" key={`d${d}`} defaultValue={d}
            onBlur={e => onBedSize(bedWidth, +e.target.value)}
            onKeyDown={blurOnEnter} data-testid="bed-d-card" />
          mm
        </span>
      </div>
      <div className="sc-info"><span>Nozzle Ø</span><b>{nozzleDia} mm</b></div>
    </section>
  )
}
