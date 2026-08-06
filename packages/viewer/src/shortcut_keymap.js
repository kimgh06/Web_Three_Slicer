// Keyboard shortcuts (upstream SPECS §4 + PrusaSlicer/Cura conventions).
// Which keys are live depends on Prepare/Preview. All are ignored while an input widget has focus.
// The component rebuilds the handler each render so it closes over fresh state; this file only holds the map.
export function makeKeyHandler(deps) {
  return (e) => {
    // Shadow DOM: at window level e.target is retargeted to the shadow host -> use composedPath to find the real target
    const t = e.composedPath ? e.composedPath()[0] : e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    const k = e.key, low = typeof k === 'string' ? k.toLowerCase() : ''
    const mod = e.ctrlKey || e.metaKey
    const stop = () => { e.preventDefault(); e.stopPropagation() }

    if (mod) {                                            // ---- Ctrl/⌘ combinations (both modes) ----
      if (low === 'r') { stop(); if (!deps.slicing) deps.slice('current') }        // slice (upstream Ctrl+R)
      else if (low === 'c') { stop(); deps.copy() }
      else if (low === 'v') { stop(); deps.paste() }
      else if (low === 'x') { stop(); deps.copy(); deps.remove() }
      else if (low === 'k' || low === 'd') { stop(); deps.duplicate() }  // Ctrl+K (upstream) / ⌘D (macOS convention)
      return
    }

    if (deps.isPreview()) {                               // ---- Preview: layer inspection ----
      const step = e.shiftKey ? 10 : 1
      if (k === 'ArrowUp')        { stop(); deps.stepLayer(step) }
      else if (k === 'ArrowDown') { stop(); deps.stepLayer(-step) }
      else if (low === 'l')       { stop(); deps.toggleSingleLayer() }
      else if (low === 't')       { stop(); deps.toggleTravel() }
      else if (low === 'z')       { stop(); deps.zoomAll() }
      else if (low === 'b')       { stop(); deps.zoomBed() }
      else if (k === 'Escape')    { stop(); deps.leavePreview() }
      return
    }

    // ---- Prepare: object manipulation ----
    if (low === 'm' || low === 'g') { stop(); deps.setGizmo('translate') }       // M = upstream, G = Blender convention (kept)
    else if (low === 'r')           { stop(); deps.setGizmo('rotate') }
    else if (low === 's')           { stop(); deps.setGizmo('scale') }
    else if (low === 'z')           { stop(); deps.zoomAll() }
    else if (low === 'b')           { stop(); deps.zoomBed() }
    else if (k === 'Delete' || k === 'Backspace') { stop(); deps.remove() }
    else if (k === 'Escape')        { stop(); deps.cancelTool() }
    else if (k === 'PageUp')        { stop(); deps.rotateSelected(Math.PI / 4) }
    else if (k === 'PageDown')      { stop(); deps.rotateSelected(-Math.PI / 4) }
    else if (k.startsWith?.('Arrow')) {                                     // nudge: 10mm, Shift = 1mm (Prusa convention)
      stop(); const d = e.shiftKey ? 1 : 10
      deps.nudgeSelected(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0,
                         k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0)
    }
    else if (k === '?')             { stop(); deps.toggleHelp() }
  }
}
