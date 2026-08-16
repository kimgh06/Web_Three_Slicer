// printer-showcase — the embed unit.
//
// This is the whole three-slicer integration: mount <SlicerSection/> anywhere on a product page and it
// brings its own machine list, its own settings state and the viewer. It imports nothing but the package,
// so it can be dropped into an existing marketing site as-is.
//
// The viewer is Shadow DOM isolated, so the host page's CSS cannot reach inside it — and this file adds no
// global styles of its own. Everything it renders outside the viewer is scoped under `.ts-embed`.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Viewport from 'three-slicer/viewer'
import {
  printerKeys, printerSettings, printerDefaultPreset,
  processPresets, filamentPresets, settingScalar,
} from 'three-slicer/settings'

// Three machines from the same vendor, all 0.4 nozzle, with visibly different beds (180 / 256 / 256 mm)
// and different motion limits. The label is the marketing name, the profile is the lookup key — they are
// not the same string and a picker should never conflate them.
const MACHINES = [
  { label: 'ACME A1 mini', profile: 'Bambu Lab A1 mini 0.4 nozzle', blurb: 'Compact bed-slinger' },
  { label: 'ACME P1', profile: 'Bambu Lab P1S 0.4 nozzle', blurb: 'Enclosed CoreXY' },
  { label: 'ACME X1', profile: 'Bambu Lab X1 Carbon 0.4 nozzle', blurb: 'Flagship, hardened nozzle' },
]

const LAYER_HEIGHTS = [
  { value: 0.12, label: '0.12 mm — Fine' },
  { value: 0.2, label: '0.20 mm — Standard' },
  { value: 0.28, label: '0.28 mm — Draft' },
]
const INFILLS = [10, 15, 25, 40]

const without = (source, keys) => {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

/** printer -> its default process -> a compatible material. Each catalog's keys are cleared first. */
function machineSettings(profile, presets) {
  const machine = printerSettings(profile)
  if (!machine || !presets) return machine ?? {}

  const { processApi, filamentApi } = presets
  let settings = { ...machine }

  const processName = printerDefaultPreset(profile) || processApi.listFor(profile)[0]
  const processSettings = processName ? processApi.settingsFor(processName) : null
  if (processSettings) settings = { ...without(settings, processApi.keys), ...processSettings }

  const materials = filamentApi.recommendedFor(profile).length
    ? filamentApi.recommendedFor(profile)
    : filamentApi.listFor(profile)
  const filamentSettings = materials[0] ? filamentApi.settingsFor(materials[0].name) : null
  if (filamentSettings) settings = { ...without(settings, filamentApi.keys), ...filamentSettings }

  return settings
}

// Every rule is under .ts-embed: this component adds nothing global to the page it is mounted on.
const EMBED_CSS = `
.ts-embed { --ts-line: #2a2f3a; --ts-muted: #97a1b2; color: #e8eaf0; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
.ts-embed .ts-machines { display: flex; flex-wrap: wrap; gap: 8px; }
.ts-embed .ts-machine {
  flex: 1 1 160px; display: flex; flex-direction: column; gap: 2px; text-align: left;
  padding: 10px 12px; border: 1px solid var(--ts-line); border-radius: 10px;
  background: #141821; color: inherit; font: inherit; cursor: pointer;
}
.ts-embed .ts-machine.is-active { border-color: #4c8dff; background: #4c8dff1f; }
.ts-embed .ts-machine span { color: var(--ts-muted); font-size: 12px; }
.ts-embed .ts-bed { color: var(--ts-muted); font-size: 13px; margin: 10px 0; }
.ts-embed .ts-frame {
  position: relative; height: min(60vh, 460px);
  border: 1px solid var(--ts-line); border-radius: 12px; overflow: hidden;
}
.ts-embed .ts-controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; margin-top: 12px; }
.ts-embed .ts-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ts-muted); }
.ts-embed .ts-field select {
  background: #141821; color: #e8eaf0; border: 1px solid var(--ts-line);
  border-radius: 8px; padding: 8px 10px; font-size: 14px;
}
.ts-embed .ts-stats { display: flex; gap: 20px; margin: 0 0 0 auto; }
.ts-embed .ts-stats dt { color: var(--ts-muted); font-size: 12px; }
.ts-embed .ts-stats dd { margin: 2px 0 0; font-size: 18px; font-variant-numeric: tabular-nums; }
.ts-embed .ts-hint { color: var(--ts-muted); font-size: 13px; margin: 12px 0 0; }
.ts-embed .ts-boundary {
  color: var(--ts-muted); font-size: 12px; margin: 8px 0 0;
  border-left: 2px solid var(--ts-line); padding-left: 10px;
}
@media (max-width: 480px) {
  .ts-embed .ts-stats { margin-left: 0; }
}
`

const duration = seconds => {
  const total = Math.round(Number(seconds) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

export default function SlicerSection() {
  const [presets, setPresets] = useState(null)
  const [machine, setMachine] = useState(MACHINES[1])
  const [settings, setSettings] = useState(() => printerSettings(MACHINES[1].profile) ?? {})
  const [progress, setProgress] = useState(0)
  const [slicing, setSlicing] = useState(false)
  const [stats, setStats] = useState(null)
  const [notice, setNotice] = useState('')

  // The preset catalogs are loaded on demand, so the first settings map is printer-only and gets
  // completed once they arrive.
  useEffect(() => {
    let live = true
    Promise.all([processPresets(), filamentPresets()]).then(([processApi, filamentApi]) => {
      if (live) setPresets({ processApi, filamentApi })
    })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (presets) setSettings(machineSettings(machine.profile, presets))
  }, [presets, machine])

  const bed = useMemo(() => {
    const corners = settings.printable_area ?? []
    const xs = corners.map(p => Number(Array.isArray(p) ? p[0] : String(p).split('x')[0]))
    const ys = corners.map(p => Number(Array.isArray(p) ? p[1] : String(p).split('x')[1]))
    if (!xs.length) return null
    return {
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...ys) - Math.min(...ys),
      height: Number(settingScalar(settings, 'printable_height') ?? 0),
    }
  }, [settings])

  const grams = useMemo(() => {
    if (!stats?.filament_mm) return 0
    const diameter = Number(settingScalar(settings, 'filament_diameter') ?? 1.75)
    const density = Number(settingScalar(settings, 'filament_density') ?? 1.24)
    return Number(stats.filament_mm) * Math.PI * (diameter / 2) ** 2 * density / 1000
  }, [stats, settings])

  const onEvent = useCallback(event => {
    if (event.type === 'progress') setProgress(event.value)
    else if (event.type === 'slicing') setSlicing(event.value)
    else if (event.type === 'error' || event.type === 'notice') setNotice(event.value)
  }, [])

  const onSliced = useCallback(({ stats: sliced }) => setStats(sliced), [])

  return (
    <div className="ts-embed">
      {/* Scoped to .ts-embed and carried in this file, so mounting the component needs no stylesheet.
          Everything inside the viewer is Shadow DOM and is not reachable from here either way. */}
      <style>{EMBED_CSS}</style>

      <div className="ts-machines" role="group" aria-label="Choose a printer">
        {MACHINES.map(entry => (
          <button
            key={entry.profile}
            type="button"
            className={entry.profile === machine.profile ? 'ts-machine is-active' : 'ts-machine'}
            aria-pressed={entry.profile === machine.profile}
            onClick={() => { setMachine(entry); setStats(null); setNotice('') }}
          >
            <strong>{entry.label}</strong>
            <span>{entry.blurb}</span>
          </button>
        ))}
      </div>

      <p className="ts-bed">
        {bed
          ? `Build volume ${bed.width} × ${bed.depth} × ${bed.height} mm · 0.4 mm nozzle`
          : 'Loading machine profile…'}
      </p>

      {/* The viewer fills its nearest positioned ancestor and has no width/height props of its own. */}
      <div className="ts-frame">
        <Viewport
          settings={settings}
          setSettings={setSettings}
          defaultAutoSlice
          onEvent={onEvent}
          onSliced={onSliced}
          panels={{
            topBar: false, objectToolbar: false, paintPanel: false, plateBar: false, statsCard: false,
            printerCard: false, filamentCard: false, processCard: false, objectList: false, towerCard: false,
          }}
          features={{ shortcuts: false, logs: false }}
        />
      </div>

      <div className="ts-controls">
        <label className="ts-field">
          <span>Layer height</span>
          <select
            value={String(settingScalar(settings, 'layer_height') ?? 0.2)}
            onChange={event => setSettings(prev => ({ ...prev, layer_height: Number(event.target.value) }))}
          >
            {LAYER_HEIGHTS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="ts-field">
          <span>Infill</span>
          <select
            value={String(settingScalar(settings, 'sparse_infill_density') ?? 15)}
            onChange={event => setSettings(prev => ({ ...prev, sparse_infill_density: Number(event.target.value) }))}
          >
            {INFILLS.map(value => <option key={value} value={value}>{value}%</option>)}
          </select>
        </label>

        <dl className="ts-stats">
          <div>
            <dt>Print time</dt>
            <dd>{slicing ? `Slicing ${Math.round(progress * 100)}%` : stats ? duration(stats.time_estimate) : '—'}</dd>
          </div>
          <div>
            <dt>Filament</dt>
            <dd>{stats ? `${grams.toFixed(1)} g` : '—'}</dd>
          </div>
        </dl>
      </div>

      <p className="ts-hint" role="status">
        {notice || 'Drop an STL on the plate — it slices on this machine, in your browser.'}
      </p>

      {/* The boundary, said out loud: this component's own markup lives in the host page and takes the
          host page's CSS (this demo's is deliberately hostile). The viewer does not. */}
      <p className="ts-boundary">
        The controls above are the host page's DOM, so its CSS reaches them — that is why the dropdowns are
        magenta and the buttons uppercase. Everything inside the frame is Shadow DOM and is untouched by it.
      </p>
    </div>
  )
}
