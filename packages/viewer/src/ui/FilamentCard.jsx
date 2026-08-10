import React, { useEffect, useMemo, useState } from 'react'
import { filamentPresets } from 'three-slicer/settings'
import { uiTree } from 'three-slicer/data'

// What a material owns: every option upstream puts on the filament tab, not just the ten the kernel reads.
//  Saving only the kernel keys would silently drop the rest of the user's edits from the panel below, and the
//  dirty marker would stay clean while the form clearly changed. Verified disjoint from the printer and process
//  key sets, so clearing these on a material switch cannot undo either of those picks.
const FILAMENT_PAGE_KEYS = ['TabFilament::build', 'TabFilament::add_filament_overrides_page']
  .flatMap(builder => uiTree[builder] ?? [])
  .flatMap(page => page.groups.flatMap(group => group.options))
  .filter(key => !key.startsWith('<'))          // '<separator>'-style layout entries carry no value

// Custom materials: a derived preset is a full copy of the values, not a diff against its parent. The system
//  presets are frozen vendor data, so there is nothing for a diff to track — and a copy survives them changing.
// ponytail: localStorage, keyed by name. Swap in an injected store when these need to sync anywhere.
const STORE = 'three-slicer.filaments'
function readCustom() {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {} } catch { return {} }
}
function writeCustom(all) {
  try { localStorage.setItem(STORE, JSON.stringify(all)) } catch { /* private mode / quota — the pick still applies */ }
  return all
}
// Filament options are per-extruder vectors upstream, but a preset describes one material, so its own value is
//  always the single entry. The card stores one scalar per extruder under the same key.
const scalarOf = v => (Array.isArray(v) ? v[0] : v)

// Filament card: one material per extruder. Selecting a row aims the material/preset pickers (and the settings
// form) at that extruder; the colors keep feeding the object meshes and the prime tower.
export default function FilamentCard({ colors, onColor, onAdd, onRemove, settings, setSettings, filamentPanel }) {
  // Materials are printer-specific and live in a lazily loaded artifact, so they arrive after a printer is picked.
  const printer = settings?.printer_settings_id ?? ''
  const [api, setApi] = useState(null)
  const [custom, setCustom] = useState(readCustom)
  const [typeChoice, setTypeChoice] = useState(null)   // null = follow the picked preset's own type
  const [active, setActive] = useState(0)              // the extruder the pickers and the form edit

  const count = colors.length
  useEffect(() => { if (active >= count) setActive(count - 1) }, [count, active])

  const ownedKeys = useMemo(() => [...new Set([...(api?.keys ?? []), ...FILAMENT_PAGE_KEYS])], [api])

  // filament_settings_id is coStrings upstream — one preset name per extruder — so it holds the whole assignment.
  const materials = useMemo(() => {
    const raw = settings?.filament_settings_id
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    return Array.from({ length: count }, (_, i) => list[i] ?? '')
  }, [settings?.filament_settings_id, count])
  const picked = materials[active] ?? ''

  // Writes the whole assignment at once. Rebuilding every column (rather than patching one index) is what makes
  //  removing a material actually remove its values: an extruder set back to "Custom (defaults)" contributes null,
  //  and a column of only nulls drops out of the map entirely.
  const assign = (loaded, saved, names, prev) => {
    const keys = [...new Set([...(loaded?.keys ?? []), ...FILAMENT_PAGE_KEYS])]
    const columns = names.map(name => (name ? (saved[name] ?? loaded?.settingsFor(name) ?? null) : null))
    const next = { ...prev }
    for (const key of keys) delete next[key]
    for (const key of keys) {
      const column = columns.map(vals => (vals && key in vals ? scalarOf(vals[key]) : null))
      if (column.some(v => v != null)) next[key] = column
    }
    if (names.every(name => !name)) { delete next.filament_settings_id; return next }
    next.filament_settings_id = names
    return next
  }
  const applyAt = (index, name, prev, saved = custom) =>
    assign(api, saved, materials.map((n, i) => (i === index ? name : n)), prev)

  // Deleting a filament deletes the SELECTED extruder, not the last one — the host reassigns objects and colors
  //  at that index, and the material columns here have to lose the same index or every later tool would shift
  //  onto its neighbour's temperatures.
  const removeExtruder = () => {
    if (count <= 1) return
    onRemove?.(active)
    setSettings?.(prev => assign(api, custom, materials.filter((_, i) => i !== active), prev))
    setActive(current => Math.max(0, Math.min(current, count - 2)))
  }

  // "Modified" = this extruder's column differs from what its preset applies. The map is sparse, so a key being
  //  present is not enough — applying a preset writes its keys in verbatim.
  const preset = api && picked ? (custom[picked] ?? api.settingsFor(picked)) : null
  const dirty = !!api && ownedKeys.some(key => {
    if (!(key in (settings ?? {}))) return false
    const mine = Array.isArray(settings[key]) ? settings[key][active] : scalarOf(settings[key])
    return JSON.stringify(mine ?? null) !== JSON.stringify(scalarOf(preset?.[key]) ?? null)
  })

  const saveAs = () => {
    const suggested = (picked || 'My material').replace(/\s*@.*$/, '') + (custom[picked] ? '' : ' (custom)')
    const name = window.prompt(`Save T${active + 1}'s filament settings as:`, suggested)?.trim()
    if (!name) return
    const vals = {}
    for (const key of ownedKeys) {
      if (!(key in (settings ?? {}))) continue
      const mine = Array.isArray(settings[key]) ? settings[key][active] : scalarOf(settings[key])
      if (mine != null) vals[key] = [mine]        // stored the way a preset stores it: one material, one value
    }
    const saved = writeCustom({ ...custom, [name]: vals })
    setCustom(saved)
    setTypeChoice('Saved')      // the new material only lives there — staying on ABS would blank the preset box
    setSettings?.(prev => applyAt(active, name, prev, saved))
  }
  const remove = () => {
    if (!custom[picked] || !window.confirm(`Delete the saved material "${picked}"?`)) return
    const { [picked]: _gone, ...rest } = custom
    setCustom(writeCustom(rest))
    setTypeChoice(null)         // "Saved" may have just disappeared; fall back to following the picked preset
    setSettings?.(prev => applyAt(active, '', prev, rest))
  }

  useEffect(() => {
    let live = true
    // The catalog loads regardless of the printer: without one the picker offers the whole vendor catalog
    //  (a material choice is meaningful before a machine is), just with no compatibility narrowing.
    filamentPresets().then(loaded => {
      if (!live) return
      setApi(loaded)
      if (!printer) return
      // Start every extruder on the vendor's own recommendation rather than leaving temperatures at the schema
      //  defaults — same reasoning as the printer card's quality preset: an unset material looks like nothing
      //  happened. This also runs on a printer *change*, which is where the previous machine's materials have to
      //  go: they are usually not in the new machine's compatible list.
      setSettings?.(prev => {
        if (prev.printer_settings_id !== printer) return prev          // a newer pick already superseded this load
        const compatible = loaded.listFor(printer)
        const saved = readCustom()
        const fallback = loaded.recommendedFor(printer)[0] ?? compatible[0]
        const raw = prev.filament_settings_id
        const current = Array.isArray(raw) ? raw : (raw ? [raw] : [])
        // A saved material carries no compatibility list of its own — the user made it, so it stays across printers.
        const keep = name => name && (name in saved || compatible.some(m => m.name === name))
        const names = Array.from({ length: count }, (_, i) => (keep(current[i]) ? current[i] : (fallback?.name ?? '')))
        if (names.every((n, i) => n === (current[i] ?? ''))) return prev
        return assign(loaded, saved, names, prev)
      })
    })
    return () => { live = false }
  }, [printer, count])   // eslint-disable-line react-hooks/exhaustive-deps

  // Material type is the first choice, the preset the second: a printer offers up to 219 compatible presets but
  //  only ~34 types, so picking ABS first cuts the second list to a handful. Vendor is not a third axis — it is
  //  already spelled out in every preset name, and crossing it with type would shatter both lists.
  const catalog = useMemo(() => {
    const byType = new Map()
    if (!api) return { types: [], byType }
    const push = (type, material) => { if (!byType.has(type)) byType.set(type, []); byType.get(type).push(material) }
    for (const name of Object.keys(custom).sort((a, b) => a.localeCompare(b))) push('Saved', { name })
    if (printer) for (const material of api.recommendedFor(printer)) push('★ Recommended', material)
    // A recommended material stays listed under its own type too: the two selects are separate lists, so it is
    //  reachable either way instead of disappearing from ABS because the vendor happened to recommend it.
    for (const material of (printer ? api.listFor(printer) : api.all())) push(material.type || 'Other', material)
    const lead = ['Saved', '★ Recommended'].filter(type => byType.has(type))
    const rest = [...byType.keys()].filter(type => !lead.includes(type)).sort((a, b) => a.localeCompare(b))
    return { types: [...lead, ...rest], byType }
  }, [api, printer, custom])

  // The type select follows the selected extruder's preset unless the user drove it themselves.
  useEffect(() => { setTypeChoice(null) }, [printer, active])
  const typeOf = (name) => {
    if (!name || !api) return null
    if (custom[name]) return 'Saved'
    const found = (printer ? api.listFor(printer) : api.all()).find(material => material.name === name)
    return found ? (found.type || 'Other') : null
  }
  const activeType = typeChoice ?? typeOf(picked) ?? catalog.types[0] ?? ''
  const presets = catalog.byType.get(activeType) ?? []

  const pickType = (next) => {
    setTypeChoice(next)
    // Land on a real material rather than an empty preset box, and prefer the vendor's own: the list is in
    //  upstream order, which is alphabetical, so "ABS" would otherwise open on a third-party BETA ABS.
    const inType = catalog.byType.get(next) ?? []
    const recommended = new Set((catalog.byType.get('★ Recommended') ?? []).map(m => m.name))
    const first = inType.find(m => recommended.has(m.name)) ?? inType[0]
    if (first) setSettings?.(prev => applyAt(active, first.name, prev))
  }

  // The settings form edits one value per key; with several extruders loaded that would flatten the column and
  //  drop the other tools' materials. So the form sees the selected extruder's slice of each column, and its
  //  edits are written back at that index. Passing `filamentPanel` as a function is what makes that possible —
  //  a ready-made node is already bound to the host's own settings pair.
  const project = (map) => {
    if (count < 2) return map
    const view = { ...map }
    for (const key of ownedKeys) if (Array.isArray(view[key])) view[key] = view[key][active]
    return view
  }
  const setPanelSettings = (updater) => setSettings?.(prev => {
    const before = project(prev)
    const after = typeof updater === 'function' ? updater(before) : updater
    if (count < 2) return after
    const next = { ...prev }
    for (const key of Object.keys(after)) {
      if (JSON.stringify(after[key]) === JSON.stringify(before[key])) continue
      if (!ownedKeys.includes(key)) { next[key] = after[key]; continue }
      const column = Array.isArray(prev[key]) ? [...prev[key]] : Array.from({ length: count }, () => null)
      column[active] = scalarOf(after[key])
      next[key] = column
    }
    for (const key of Object.keys(before)) {          // a per-option reset removes the key -> clear this extruder
      if (key in after || !ownedKeys.includes(key)) continue
      const column = Array.isArray(prev[key]) ? [...prev[key]] : Array.from({ length: count }, () => null)
      column[active] = null
      if (column.every(v => v == null)) delete next[key]; else next[key] = column
    }
    return next
  })
  const panel = typeof filamentPanel === 'function' ? filamentPanel(project(settings ?? {}), setPanelSettings) : filamentPanel

  const label = name => (name ? name.replace(/\s*@.*$/, '') : '—')
  return (
    <section className="side-card" data-testid="filament-section">
      <div className="sc-head">🧵 Filament <span className="sc-count">{count}</span>
        <span className="sc-head-btns">
          <button onClick={onAdd} disabled={count >= 4} title="Add a filament (extruder) — up to 4, assignable per object" data-testid="filament-add">+</button>
          <button onClick={removeExtruder} disabled={count <= 1} title="Remove the selected filament — objects using it move to T1, later tools shift down" data-testid="filament-del">−</button>
        </span>
      </div>
      {colors.map((c, i) => (
        <div className={`filament-row${i === active ? ' fil-active' : ''}`} key={i}
             onClick={() => setActive(i)} data-testid={`filament-row-${i}`}
             title={materials[i] ? `T${i + 1}: ${materials[i]}` : `T${i + 1}: no material picked`}>
          <input type="color" value={c} onClick={e => e.stopPropagation()} onChange={e => onColor(i, e.target.value)}
                 title={`T${i + 1} filament color`} data-testid={`filament-color-${i}`} />
          <span className="fil-t">T{i + 1}</span>
          <span className="fil-mat" data-testid={`filament-material-${i}`}>{label(materials[i])}</span>
        </div>
      ))}
      {count > 2 && (
        <div className="sc-info sc-note">Slicing uses two materials (T1/T2); further extruders are colors only.</div>
      )}
      {catalog.types.length > 0 && (<>
        <div className="sc-info"><span>{count > 1 ? `T${active + 1} material` : 'Material'}</span>
          <select className="sc-model" value={activeType} onChange={e => pickType(e.target.value)}
            data-testid="filament-type" title="Material type — narrows the presets below to the ones made of it">
            {catalog.types.map(type => (
              <option key={type} value={type}>{type} ({catalog.byType.get(type).length})</option>
            ))}
          </select>
        </div>
        <div className="sc-info"><span>Preset</span>
          {/* Native selects on purpose: type-ahead over a long list is free here and hand-written in any custom dropdown. */}
          <select className="sc-model" value={picked} onChange={e => setSettings?.(prev => applyAt(active, e.target.value, prev))}
            data-testid="filament-preset" title="Material preset from the upstream vendor profiles — temperatures, flow ratio, cooling and retraction">
            <option value="">Custom (defaults)</option>
            {presets.map(m => <option key={m.name} value={m.name}>{label(m.name)}</option>)}
          </select>
        </div>
        <div className="sc-info"><span className="sc-dirty">{dirty ? '● Modified' : ''}</span>
          <span className="sc-head-btns sc-preset-btns">
            <button onClick={saveAs} data-testid="filament-save"
              title="Save this extruder's filament values as your own material — system presets are vendor data and stay read-only">Save as…</button>
            <button onClick={remove} disabled={!custom[picked]} data-testid="filament-delete"
              title="Delete this saved material">Delete</button>
          </span>
        </div>
      </>)}
      {/* The editor itself is injected by the host (same slot pattern as the printer card's motion panel), so the
          viewer keeps no second copy of the settings form. Editing here is what makes a preset "Modified". */}
      {panel && catalog.types.length > 0 && (
        <details className="sc-fold" data-testid="filament-fold">
          <summary><span className="sc-fold-lbl">Settings</span><b>{dirty ? 'Modified' : 'Preset'}</b></summary>
          <div className="sc-fold-body">{panel}</div>
        </details>
      )}
    </section>
  )
}
