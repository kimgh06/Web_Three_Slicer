import React from 'react'

// Right-click menu over the canvas. `menu` is {x, y, onObject}; every entry closes the menu first.
export default function ContextMenu({ menu, onClose, canPaste, actions }) {
  const run = (fn) => () => { onClose(); fn?.() }
  return (
    <>
      <div className="ctx-scrim" onPointerDown={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} data-testid="ctx-menu">
        {menu.onObject ? (<>
          <button onClick={run(actions.duplicate)} data-testid="ctx-duplicate" title="Duplicate the selected object at the same scale and rotation, placed beside it">Duplicate <span className="ctx-key">Ctrl+K</span></button>
          <button onClick={run(actions.copy)} data-testid="ctx-copy" title="Copy the selected object to the buffer (paste to add it)">Copy <span className="ctx-key">Ctrl+C</span></button>
          <button onClick={run(actions.split)} data-testid="ctx-split" title="Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)">Split</button>
          <button onClick={run(actions.placeOnBed)} data-testid="ctx-seat" title="Drop every object onto the bed (Z=0)">Place on bed</button>
          <hr />
          <button className="danger" onClick={run(actions.remove)} data-testid="ctx-delete" title="Remove the selected object from the scene">Delete <span className="ctx-key">Del</span></button>
        </>) : (<>
          <button onClick={run(actions.openFile)} data-testid="ctx-open" title="Open a model file and add it to the current plate">Open model…</button>
          <button disabled={!canPaste} onClick={run(actions.paste)} data-testid="ctx-paste" title="Add the copied object to the current plate">Paste <span className="ctx-key">Ctrl+V</span></button>
          <hr />
          <button onClick={run(actions.zoomAll)} data-testid="ctx-zoom-all" title="Fit the camera so every object is visible">Zoom all <span className="ctx-key">Z</span></button>
          <button onClick={run(actions.zoomBed)} data-testid="ctx-zoom-bed" title="Fit the camera to the whole selected plate">Zoom bed <span className="ctx-key">B</span></button>
        </>)}
      </div>
    </>
  )
}
