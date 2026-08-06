import React from 'react'
import { openIcon } from '../icons.js'

// S1 top bar: logo + open button, the Prepare|Preview tabs, and the undo/redo placeholders.
export default function TopBar({ showTabs, canvasMode, onCanvasMode, previewEnabled, onOpen }) {
  return (
    <header className="topbar">
      <div className="tb-left">
        <a href="/" className="tb-logo"><b>Three</b>Slicer <span className="tb-re">RE</span></a>
        <button className="tb-btn" onClick={onOpen} title="Open a model file — every existing object is cleared" data-testid="open-file"><img src={openIcon} alt="" /><span>Open</span></button>
      </div>
      {showTabs && (
        <div className="tb-tabs" role="tablist" aria-label="Canvas mode">
          <button role="tab" className={canvasMode === 'prepare' ? 'on' : ''} onClick={() => onCanvasMode('prepare')} data-testid="mode-prepare" title="Arrange, transform and paint supports">Prepare</button>
          <button role="tab" className={canvasMode === 'preview' ? 'on' : ''} onClick={() => onCanvasMode('preview')} disabled={!previewEnabled} data-testid="mode-preview" title="Preview the sliced toolpaths (enabled after slicing)">Preview</button>
        </div>
      )}
      <div className="tb-right">
        <button className="tb-icon" disabled title="Undo — not implemented (needs an action history stack)">↶</button>
        <button className="tb-icon" disabled title="Redo — not implemented (needs an action history stack)">↷</button>
      </div>
    </header>
  )
}
