import React from 'react'

const hms = (seconds) => {
  const s = Math.round(seconds)
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
}

// Slice result summary — rendered in the viewport card in Preview.
export default function StatsCard({ stats, overBed }) {
  if (!stats) return null
  return (
    <>
      <div><b>{stats.layers}</b> layers · <b>{stats.segments}</b> segments</div>
      <div>Filament <b>{stats.filament.toFixed(1)}</b> mm</div>
      {typeof stats.timeSec === 'number' && stats.timeSec > 0 && (
        <div data-testid="print-time">⏱ Estimated print <b>{hms(stats.timeSec)}</b></div>
      )}
      {overBed && <div className="slice-warn" data-testid="over-bed">⚠ Model extends beyond the bed</div>}
    </>
  )
}
