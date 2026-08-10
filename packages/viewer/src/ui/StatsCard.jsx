import React from 'react'

const hms = (seconds) => {
  const s = Math.round(seconds)
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
}

const ENGINE_LABEL = { full: 'GCodeProcessor', transcribed: 'transcribed planner', fallback: 'fallback' }

// Slice result summary — rendered in the viewport card in Preview.
export default function StatsCard({ stats, overBed }) {
  if (!stats) return null
  return (
    <>
      <div><b>{stats.layers}</b> layers · <b>{stats.segments}</b> segments</div>
      <div>Filament <b>{stats.filament.toFixed(1)}</b> mm</div>
      {typeof stats.timeSec === 'number' && stats.timeSec > 0 && (<>
        <div data-testid="print-time">⏱ Estimated print <b>{hms(stats.timeSec)}</b></div>
        {stats.limits && (
          // What the estimator actually ran with, echoed back by the kernel — not re-derived from the settings,
          //  so an unwired limit shows up as a mismatch here instead of being silently reported as applied.
          <div className="sc-sub" data-testid="print-time-basis"
               title={Object.entries(stats.limits).map(([k, v]) => `${k}: ${v}`).join('\n')}>
            {ENGINE_LABEL[stats.engine] ?? stats.engine} · {stats.limits.max_speed_xy} mm/s
            · {stats.limits.accel_print} mm/s² · jerk {stats.limits.jerk_xy}
          </div>
        )}
      </>)}
      {overBed && <div className="slice-warn" data-testid="over-bed">⚠ Model extends beyond the bed</div>}
    </>
  )
}
