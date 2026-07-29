// independence-check: render <SettingsPanel/> completely standalone — ONLY local useState, no App,
// no React context, no router (onOptionOpen omitted → plain labels). Proves @three-slicer/components has
// zero global/context coupling. Editing any field mutates local state, shown live in the <pre>.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import SettingsPanel from '@three-slicer/components/SettingsPanel'

function Standalone() {
  const [settings, setSettings] = useState({})
  return (
    <div style={{ font: '14px system-ui', padding: 12 }}>
      <h1 style={{ fontSize: 18 }}>independence-check — &lt;SettingsPanel/&gt; standalone</h1>
      <p>No App, no context, no router. Local state only:</p>
      <pre data-testid="settings-json" style={{ background: '#f4f4f4', padding: 8 }}>{JSON.stringify(settings)}</pre>
      <SettingsPanel settings={settings} setSettings={setSettings} />
    </div>
  )
}
createRoot(document.getElementById('root')).render(<Standalone />)
