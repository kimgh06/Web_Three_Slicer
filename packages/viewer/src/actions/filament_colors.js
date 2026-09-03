import { MAX_PAINT_EXTRUDERS } from './support_paint.js'

// Default colour per extruder slot, up to the selector's own ceiling of 16 (support_paint.js). A literal table
// rather than a generated hue ramp because <input type="color"> only accepts hex, so a generated colour would need
// an hsl->hex conversion written for a value the user immediately overrides anyway. The first two entries are the
// long-standing T1/T2 defaults — an existing project must not change colour because the list grew.
export const DEFAULT_FILAMENT_COLORS = [
  '#6aa0dc', '#e08a2b', '#e0473b', '#3bb0e0', '#7ad14a', '#b06ad1', '#d1c34a', '#4ad1a8',
  '#d16a9a', '#6a7ad1', '#8fd16a', '#d18f6a', '#6ad1d1', '#c74ad1', '#a8a8a8', '#4a6ad1',
]

// The filament list: its colours, and adding or removing a slot.
//
// The colour lives in TWO places on purpose and they have to be written together. `extruderColors` is what the
// viewer DRAWS with — the object bodies, the paint chips, the paint overlay, the toolpath Filament view — and is
// component state so those re-render. `filament_colour` is what the SETTINGS MAP carries: it is the key upstream
// stores the palette under, so it is what `<SettingsPanel/>` edits, what a "Save as 3mf" writes out, and what a
// project import reads back (`applyProjectFilaments`, actions/model_load.js). Only the import direction existed:
// picking a colour moved the state and left the settings map holding whatever the project had, so the swatch and
// the saved file disagreed from the first click — and a project saved after recolouring came back in the old
// colours. Every mutation below therefore mirrors the new list into the settings map.
//
// `extruderColorsRef` is written SYNCHRONOUSLY by its setter (use_state_ref.js), so the mirror reads the list that
// was just set rather than threading it through by hand.
export function makeFilamentColors(deps) {
  const {
    extruderColorsRef, setExtruderColors, setSettings, apiRef, objectsRef, refreshObjects, applyViewColors, selectFilament,
  } = deps

  const mirrorToSettings = () => setSettings?.(prev => ({ ...prev, filament_colour: [...extruderColorsRef.current] }))

  function setExtColor(index, hex) {
    setExtruderColors(colors => colors.map((color, i) => (i === index ? hex : color)))
    mirrorToSettings()
    apiRef.current?.recolorObjects()
    applyViewColors()
  }

  function addFilament() {
    setExtruderColors(colors => (colors.length >= MAX_PAINT_EXTRUDERS
      ? colors : [...colors, DEFAULT_FILAMENT_COLORS[colors.length] || '#888888']))
    mirrorToSettings()
  }

  // Deleting removes the SELECTED extruder, not the last one, so the objects assigned to it and to every later
  //  slot have to be moved with it — otherwise each of them would silently inherit its neighbour's filament.
  function removeFilament(index) {
    const colors = extruderColorsRef.current
    if (colors.length <= 1) return
    // The card passes the selected extruder's index; a bare call (older hosts) still removes the last one.
    const removed = Number.isInteger(index) ? Math.min(Math.max(index, 0), colors.length - 1) : colors.length - 1
    setExtruderColors(colors.filter((_color, i) => i !== removed))
    mirrorToSettings()
    for (const object of objectsRef.current) {
      const extruder = object.extruder || 1
      if (extruder === removed + 1) apiRef.current?.setObjectExtruder(object.id, 1)          // its filament is gone -> back to T1
      else if (extruder > removed + 1) apiRef.current?.setObjectExtruder(object.id, extruder - 1)   // later tools shift down one slot
    }
    apiRef.current?.recolorObjects()
    refreshObjects()
    // The slot the selection pointed at may be gone, or may now be past the end. selectFilament moves the card and
    //  the brush together, which is what stops the two from drifting apart the moment a filament is deleted.
    selectFilament?.(Math.min(removed, extruderColorsRef.current.length - 1))
  }

  return { setExtColor, addFilament, removeFilament }
}
