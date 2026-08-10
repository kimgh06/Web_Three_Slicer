import React, { useState } from 'react'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
import Landing from './Landing.jsx'

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
          only={{ builder: 'TabPrinter::build_kinematics_page' }} />} />
    </div>
  )
}

// The landing page (/) is kept separate from the slicer (/slice). The landing page lives outside the 3D
// shell so it renders without initializing three.js/WASM — someone who only came to read about it
// should not load the kernel.
export const routes = [
  { path: '/', element: <Landing /> },
  { path: '/slice', element: <Prepare /> },
]
