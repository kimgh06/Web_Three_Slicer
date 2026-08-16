import React, { useState } from 'react'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
import './step_loader.js'   // registers the .step/.stp loader (the OCCT WASM only loads when such a file is actually opened)

// The slicer screen. Viewport owns the desktop-style shell (top bar + left gizmo rail + center viewport
// + right sidebar) and the process section embeds SettingsPanel through processPanel, so both sides
// share one settings map.
// It lives in its own module so App.jsx can reach it through React.lazy: three.js and the settings panel
// are the bulk of the bundle, and the landing page has no use for either.
export default function Prepare() {
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
