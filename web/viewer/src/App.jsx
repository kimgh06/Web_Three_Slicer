import React, { useState } from 'react'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
import Landing from './Landing.jsx'
import TestBed from './TestBed.jsx'

// The slicer screen. Viewport owns the desktop-style shell (top bar + left gizmo rail + center viewport
// + right sidebar) and the process section embeds SettingsPanel through processPanel, so both sides
// share one settings map.
function Prepare() {
  const [settings, setSettings] = useState({})   // sparse map (edited keys only). Reset on reload.
  return (
    <div className="prepare">
      <Viewport settings={settings} setSettings={setSettings}
        processPanel={<SettingsPanel embedded settings={settings} setSettings={setSettings} />}
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

// The landing page (/) is kept separate from the slicer (/slice). The landing page lives outside the 3D
// shell so it renders without initializing three.js/WASM — someone who only came to read about it
// should not load the kernel.
// /testbed drives the embedding surface (panels, features, onEvent, onExport, gcode-only) from outside the
// component, with the configuration in the URL. /slice cannot do that job: it is a host that already made one set
// of choices, which is exactly what a test bed has to be able to vary.
export const routes = [
  { path: '/', element: <Landing /> },
  { path: '/slice', element: <Prepare /> },
  { path: '/testbed', element: <TestBed /> },
]
