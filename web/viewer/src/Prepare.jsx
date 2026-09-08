import { useRef, useState } from 'react'
import Viewport, { useSlicer } from 'three-slicer-viewer'            // the viewer and the slicing hook (MIT)
import { makeSlicerWorker } from 'three-slicer/client'                // the WASM kernel's worker (AGPL)
import { bundledCatalog } from 'three-slicer/settings'                // OrcaSlicer's vendor presets (AGPL)
import SettingsPanelCore from 'three-slicer-viewer/components'  // the settings form (MIT)
import { schema, uiTree } from 'three-slicer/data'                // upstream's labels, tooltips and tab tree (AGPL)
import { makeCfg, disabledKeys } from 'three-slicer/toggle'         // the evaluator bound to upstream's toggle rules (AGPL)
import { parseGcode } from 'three-slicer-viewer/gcode'
import './step_loader.js'   // registers the .step/.stp loader (the OCCT WASM only loads when such a file is actually opened)

// The slicer screen. Viewport owns the desktop-style shell (top bar + left gizmo rail + center viewport
// + right sidebar) and the process section embeds SettingsPanel through processPanel, so both sides
// share one settings map.
// It lives in its own module so App.jsx can reach it through React.lazy: three.js and the settings panel
// are the bulk of the bundle, and the landing page has no use for either.
// Googlebot's renderer (WRS) has no WebGL. Mounting Viewport there clears the pre-render fallback in
// slice/index.html and leaves an empty dark page — which Google reads as a contentless page and refuses
// to index (measured: the no-WebGL rendered DOM was 2.6KB with zero text). So detect before mounting and
// keep readable content on screen; the text mirrors the slice/index.html fallback it replaces.
const webglAvailable = (() => {
  try {
    const probeCanvas = document.createElement('canvas')
    return !!(probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl'))
  } catch { return false }
})()

const GCODE_EXT = /\.(gcode|gco|g)$/i

// The permissive panel with upstream's data plugged in — the same composition three-slicer/components makes,
//  spelled out here so the page shows which half is which. Four panels below share it.
const PANEL_DATA = { schema, uiTree, toggle: { makeCfg, disabledKeys } }
// The slicing hook bound to the kernel worker. Module-level on purpose: it is called as a hook, so its identity
//  must not change between renders.
const slicer = (deps) => useSlicer({ ...deps, makeWorker: makeSlicerWorker })
const SettingsPanel = (props) => <SettingsPanelCore {...PANEL_DATA} {...props} />

export default function Prepare() {
  const [settings, setSettings] = useState({})   // sparse map (edited keys only). Reset on reload.
  const [plateSettings, setPlateSettings] = useState({})   // per-plate sparse overrides ({plateIndex: map})
  // An opened G-code file, shown on the plate INSTEAD of a slice — any slicer's output, and the kernel never
  // starts. This is the permissive package's own use case, reached from the slicer page: the viewport parses
  // it through three-slicer-viewer/gcode, and the same parser validates it here first.
  const [gcode, setGcode] = useState(null)         // { name, text } | null
  const [gcodeError, setGcodeError] = useState('')
  const gcodePickerRef = useRef(null)

  const openGcode = async (file) => {
    const text = await file.text()
    // A garbage file would otherwise reach the plate as nothing at all; say so here instead.
    const { stats } = parseGcode(text)
    if (!stats.layers) { setGcodeError(`${file.name}: no layers found — is this G-code?`); return }
    setGcodeError('')
    setGcode({ name: file.name, text })
  }
  // CAPTURE phase, so this runs before the viewport's own drop handler inside its shadow root — which knows
  // only model formats and would reject a .gcode as unsupported. Anything that is not G-code falls through.
  const onDropCapture = (event) => {
    const file = [...(event.dataTransfer?.files ?? [])].find(f => GCODE_EXT.test(f.name))
    if (!file) return
    event.preventDefault(); event.stopPropagation()
    openGcode(file)
  }
  if (!webglAvailable) return (
    <div className="prepare" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#101418', color: '#c9d3de', font: '16px/1.6 system-ui,sans-serif', textAlign: 'center', padding: '2rem' }}>
      <div style={{ maxWidth: '38rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 600 }}>Three Slicer — slice STL to G-code in the browser</h1>
        <p>
          Open an STL, OBJ, 3MF, AMF, PLY or STEP model and slice it to G-code without leaving the
          browser. Supports, infill, multi-material and the full toolpath preview run on a WebAssembly
          build of the OrcaSlicer kernel, on this machine — nothing is uploaded to a server.
        </p>
        <p>This browser has WebGL disabled, which the 3D viewport needs — enable it or open this page in another browser.</p>
        <p>
          <a href="/" style={{ color: '#7aa7d8' }}>About Three Slicer</a>
          {' · '}
          <a href="/demos" style={{ color: '#7aa7d8' }}>integration demos</a>
        </p>
      </div>
    </div>
  )
  return (
    <div className="prepare" onDropCapture={onDropCapture}>
      <div className="prepare-gcode">
        {gcode
          ? <>
              <span>G-code · {gcode.name}</span>
              <button type="button" onClick={() => setGcode(null)} title="Close the G-code and go back to slicing">✕</button>
            </>
          : <button type="button" onClick={() => gcodePickerRef.current?.click()}>Open G-code</button>}
        {gcodeError && <span className="prepare-gcode-error">{gcodeError}</span>}
        <input ref={gcodePickerRef} type="file" accept=".gcode,.gco,.g" hidden
          onChange={event => { const f = event.target.files?.[0]; if (f) openGcode(f); event.target.value = '' }} />
      </div>
      <Viewport slicer={slicer} catalog={bundledCatalog} gcode={gcode?.text ?? null} settings={settings} setSettings={setSettings}
        plateSettings={plateSettings} setPlateSettings={setPlateSettings}
        processPanel={(panelSettings, setPanelSettings, meta) =>
          /* A function, not a node: with >1 plate the card's Global|Plate toggle hands down the selected
             plate's EFFECTIVE map and a setter that writes overrides — same shape as filamentPanel below. */
          <SettingsPanel embedded settings={panelSettings} setSettings={setPanelSettings}
            overriddenKeys={meta?.overriddenKeys} onRevertKey={meta?.onRevertKey} />}
        motionPanel={<SettingsPanel embedded settings={settings} setSettings={setSettings}
          only={{ builder: 'TabPrinter::build_kinematics_page' }} />}
        filamentPanel={(filamentSettings, setFilamentSettings) => <>
          {/* A function, not a node: with several extruders loaded the card hands down that extruder's slice of
              the per-extruder columns and writes edits back at its index. Two builders — the material's own
              settings and the page that overrides the printer's retraction. */}
          <SettingsPanel embedded settings={filamentSettings} setSettings={setFilamentSettings}
            only={{ builder: 'TabFilament::build' }} />
          <SettingsPanel embedded settings={filamentSettings} setSettings={setFilamentSettings}
            only={{ builder: 'TabFilament::add_filament_overrides_page' }} />
        </>} />
    </div>
  )
}
