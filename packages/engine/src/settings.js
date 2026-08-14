// Maps the actual values of the (editable) right-hand settings panel -> kernel slice parameters.
//  - Settings state is a sparse map (key->value): only edited keys are stored, otherwise the config-schema default.
//  - For vector types (coFloats/coInts, …) only the first element is used/edited (simplification).
import { schema, printers, loadProcesses, loadFilaments } from './data.js'

export function schemaDefault(key) { return schema[key]?.default }
export function settingRaw(settings, key) { return (settings && key in settings) ? settings[key] : schemaDefault(key) }
// Normalize to a scalar ([0] for vectors)
// A per-extruder column reduced to the single value the kernel's scalar reader wants. The FIRST SET entry, not
//  literally index 0: the filament card writes one column per extruder and leaves a null wherever that extruder has
//  no preset, so an assignment that starts at T2 puts a null at index 0. Taking that null made filament_diameter 0,
//  which divides into the extrusion maths and turned the whole slice into NaN — measured as
//  "; filament used [mm] = nan, nan" from a print whose T1 had no material picked.
export function settingScalar(settings, key) {
  const v = settingRaw(settings, key)
  if (!Array.isArray(v)) return v
  return v.find(entry => entry != null && entry !== '') ?? v[0]
}

// Stage 8: real ported Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) + the older approximations
const KERNEL_PATTERNS = ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid', 'gyroid_approx',
  'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']
const KERNEL_SEAMS = ['nearest', 'aligned', 'back', 'random']

// ---- Pass-through kernel parameters -----------------------------------------------------------------------
// The kernel reads 159 parameters (see the reference table in engine/README.md, generated from its own reader).
//  These are the ones whose schema key carries the SAME name, so the mapping is the identity and the only real
//  decision is WHEN to send them. They are sent only when the settings map actually holds the key — never filled
//  in from the schema default — because the two defaults disagree for several of them:
//  independent_support_layer_height is true in the schema and false in the kernel, printable_height is 100 there
//  and 250 here. Filling one in would silently reslice every existing caller's model. This is the same omission
//  rule the per-feature widths, the support tools and the prime tower keys already follow, and it is what keeps
//  deriveKernelParams({}) producing exactly the parameter set it produced before these keys were mapped.
const PASSTHROUGH_NUM = [
  // Real (organic) tree support shape. Upstream keeps an _organic spelling and a suffix-less one for most of
  //  these, and the kernel accepts both — preferring _organic — so both are passed as written rather than
  //  reconciled here. Before this, none of the organic tree support could be tuned from a settings map at all.
  'tree_support_branch_angle', 'tree_support_branch_angle_organic',
  'tree_support_branch_diameter', 'tree_support_branch_diameter_organic',
  'tree_support_branch_distance', 'tree_support_branch_distance_organic',
  'tree_support_branch_diameter_angle', 'tree_support_angle_slow', 'tree_support_tip_diameter',
  'tree_support_top_rate', 'tree_support_wall_count',
  'support_object_first_layer_gap',
  // The tree support's build-volume ceiling. Distinct from bed_height above — that one is the kernel's own
  //  off-the-bed check — but both come from this single schema key, because upstream has one option for both jobs.
  'printable_height',
  // Upstream's *_filament_id family: a 1-based filament index per feature, 0 meaning "whatever tool the region
  //  already prints with". slice_mm.cpp honours the wall and sparse-infill ids and reports the rest in the G-code
  //  rather than silently dropping them.
  'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id',
  'top_surface_filament_id', 'bottom_surface_filament_id', 'internal_solid_filament_id',
]
const PASSTHROUGH_BOOL = ['independent_support_layer_height']
// Per-filament vectors, one entry per filament, passed positionally like every other per-extruder array.
//  filament_map is which physical extruder each filament sits in; density and cost turn extruded millimetres into
//  the grams and currency the G-code footer reports.
const PASSTHROUGH_NUM_VECTOR = ['filament_map', 'filament_density', 'filament_cost']
// Material identity. The kernel needs the type for the two decisions upstream makes by material name (PETG's
//  extra unretract, TPU on the first layer) and the settings id for the footer.
const PASSTHROUGH_STR_VECTOR = ['filament_type', 'filament_settings_id']

// Machine limits (the "Motion ability" printer page) -> kernel time-estimate parameters.
//  Declarative on purpose: the kernel collapses X/Y into one axis, so the mapping cannot be a plain pass-through,
//  but adding a limit stays a data row instead of code. The fallback is the kernel's own default, so an unedited
//  profile produces exactly the previous estimate. Upstream leaves machine_max_*_x/y/z/e without a schema default
//  (they only ever come from a printer preset), hence the explicit fallbacks here.
const MACHINE_LIMITS = {
  machine_max_speed_xy: ['machine_max_speed_x', 500],
  machine_max_speed_z:  ['machine_max_speed_z', 12],
  machine_max_speed_e:  ['machine_max_speed_e', 30],
  machine_max_accel_xy: ['machine_max_acceleration_x', 5000],
  machine_max_accel_z:  ['machine_max_acceleration_z', 500],
  machine_max_accel_e:  ['machine_max_acceleration_e', 5000],
  machine_jerk_xy:      ['machine_max_jerk_x', 9],
  machine_jerk_z:       ['machine_max_jerk_z', 0.4],
  machine_jerk_e:       ['machine_max_jerk_e', 2.5],
  machine_accel_print:  ['default_acceleration', 5000],
  machine_accel_travel: ['travel_acceleration', 5000],
  machine_accel_retract: ['machine_max_acceleration_retracting', 5000],
}
// The schema keys the machine limits are read from — for UI that has to show "which printer characteristics are in play"
// without hardcoding key strings of its own.
export const machineLimitKeys = Object.values(MACHINE_LIMITS).map(([key]) => key)

// ---- Printer profiles -------------------------------------------------------
// printers.json is stored column-oriented (see its .d.ts). These two hide that layout so no consumer decodes it.

/** Every option key a printer profile can set — what to clear before applying a different printer. */
export const printerKeys = printers.keys

/** Vendor -> profile name -> `[nozzle, setIndex, model]`, straight from the data (for building a picker). */
export const printersByVendor = printers.byVendor

// Process (print) presets live in the ~800 KB processes.json, so they load on demand — the first call fetches,
//  later ones reuse the same promise. Returns a small facade so no caller has to know the column layout.
let processesPromise = null
export function processPresets() {
  processesPromise ??= loadProcesses().then(data => ({
    /** Every key a process preset can set — clear these before applying a different one */
    keys: data.keys,
    /** Preset names compatible with a printer profile, in upstream order */
    listFor: (printerProfileName) =>
      (data.byPrinter[printerProfileName] ?? []).map(i => data.presets[i][0]),
    /** The settings a preset applies, ready to merge. `null` when unknown. */
    settingsFor: (presetName) => {
      const preset = data.presets.find(([name]) => name === presetName)
      if (!preset) return null
      const row = data.sets[preset[1]], out = {}
      data.keys.forEach((key, i) => { if (row[i] != null) out[key] = row[i] })
      return out
    },
  }))
  return processesPromise
}

// Filament (material) presets — same lazy facade as the process presets above, over the ~540 KB filaments.js.
//  Entries come out as objects rather than bare names because a material picker groups by type, and the type
//  label only exists in this file. Both lists are in upstream order: byPrinter is the compatible set,
//  defaultsByModel the vendor's recommendation (a subset, so the two overlap by design).
let filamentsPromise = null
export function filamentPresets() {
  filamentsPromise ??= loadFilaments().then(data => {
    // type/vendor are empty strings when the profile chain declares neither — the picker buckets those itself
    const view = i => { const [name, , type, vendor] = data.presets[i]; return { name, type, vendor } }
    return {
      /** Every key a filament preset can set — clear these before applying a different material */
      keys: data.keys,
      /** Every material in the catalog — for a picker shown before any printer is chosen */
      all: () => data.presets.map((_, i) => view(i)),
      /** Materials compatible with a printer profile, as `{name, type, vendor}` */
      listFor: (printerProfileName) => (data.byPrinter[printerProfileName] ?? []).map(view),
      /** The vendor's recommended materials for that printer's model, same shape as listFor.
       *  Filtered to the compatible set, which is not redundant: the recommendation is declared on the machine
       *  *model* and so is nozzle-agnostic, while its entries name nozzle-specific presets ("… @Kobra 3 0.4 nozzle").
       *  On a 0.2 nozzle profile 41% of the raw entries (1749 of 4259 across all printers) name a material whose
       *  own compatible list excludes it — offering those would apply a preset upstream considers incompatible. */
      recommendedFor: (printerProfileName) => {
        const compatible = new Set(data.byPrinter[printerProfileName] ?? [])
        return (data.defaultsByModel[printerEntry(printerProfileName)?.[2] ?? ''] ?? [])
          .filter(i => compatible.has(i)).map(view)
      },
      /** The settings a material applies, ready to merge. `null` when unknown. */
      settingsFor: (presetName) => {
        const preset = data.presets.find(([name]) => name === presetName)
        if (!preset) return null
        const row = data.sets[preset[1]], out = {}
        data.keys.forEach((key, i) => { if (row[i] != null) out[key] = row[i] })
        return out
      },
    }
  })
  return filamentsPromise
}

function printerEntry(profileName) {
  for (const models of Object.values(printers.byVendor)) {
    const entry = models[profileName]
    if (entry) return entry
  }
  return null
}

/** The settings a printer profile applies, ready to merge into the settings map. `null` when unknown. */
export function printerSettings(profileName) {
  const entry = printerEntry(profileName)
  if (!entry) return null
  const row = printers.sets[entry[1]]
  const out = {}
  printers.keys.forEach((key, i) => { if (row[i] != null) out[key] = row[i] })
  return out
}

/** The vendor's recommended process preset for a printer, or '' when the profile names none. */
export function printerDefaultPreset(profileName) { return printerEntry(profileName)?.[3] ?? '' }

// ---- Imported project settings (a slicer-written 3mf's Metadata/project_settings.config) --------------------
// Upstream serializes every option as a STRING (or an array of them, one per extruder) — a bool is "0"/"1" and a
//  float is "0.2". This settings map holds real JS types, and the difference is not cosmetic: `bool()` below reads
//  a value with `!!v`, and `!!"0"` is TRUE — importing raw would turn every disabled option on. So each value is
//  coerced by its schema type, and anything the schema does not know (inherits_group, *_settings_id, version, the
//  whole preset-bookkeeping half of that file) is dropped rather than carried into a map keyed by schema keys.
// The `inherits` / `different_settings_to_system` machinery upstream applies on top of this (Preset.cpp:2577) is
//  deliberately NOT reproduced: it exists to reconcile a stored preset against a LOCAL vendor preset database of a
//  possibly different version. project_settings.config is already flattened, so taking its values as written is
//  both simpler and closer to what the project author actually sliced.
const FALSE_STRINGS = new Set(['0', 'false', 'no', 'off', ''])

function coerceScalar(type, value) {
  if (typeof value !== 'string') return value
  switch (type) {
    case 'coBool': case 'coBools':
      return !FALSE_STRINGS.has(value.trim().toLowerCase())
    case 'coFloat': case 'coFloats': case 'coInt': case 'coInts':
      return asNumber(value)
    case 'coPercent': case 'coPercents':
      // A percent option's value is the bare number (the schema default of sparse_infill_density is 20, not "20%")
      //  and upstream serializes it that way — but the '%' does show up in hand-edited configs, so strip it.
      return asNumber(value.trim().replace(/%$/, ''))
    case 'coFloatOrPercent': case 'coFloatsOrPercents':
      // "50%" must stay a string — the percent IS the value, and Number('50%') is NaN anyway.
      return value.trim().endsWith('%') ? value : asNumber(value)
    case 'coPoint': case 'coPoints':
      return parsePoint(value) ?? value
    case 'coPointsGroups':
      return parsePointGroup(value) ?? value
    default:
      return value   // strings and enums — the kernel and the panel both read these as written
  }
}

// Points are the other shape trap, and a quiet one: upstream writes a point as the STRING "XxY", while every
//  consumer here indexes it as a [x, y] pair — so `printable_area[1][0]` on a raw import is the CHARACTER '2' of
//  "256x0", and the bed comes out 2mm wide (measured on a real MakerWorld project: 2 x NaN).
// Two separators exist in the wild: ConfigOptionPoint::serialize writes 'x', while some Orca options
//  (best_object_pos) write "X,Y". A points GROUP is one string holding a comma-separated LIST of "XxY" points,
//  so there the comma cannot also separate a point's own coordinates — hence two parsers rather than one regex.
function parsePoint(text) {
  const split = String(text).split('x')
  const pair = split.length === 2 ? split : String(text).split(',')
  if (pair.length !== 2) return null
  const x = Number(pair[0]), y = Number(pair[1])
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}
function parsePointGroup(text) {
  const points = String(text).split(',').map(entry => {
    const [a, b] = entry.split('x')
    const x = Number(a), y = Number(b)
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  })
  return points.length && points.every(Boolean) ? points : null
}
// Number('') is 0 and Number('  ') is 0, neither of which means "the option was set to zero" — an unparsable
//  value is handed back untouched so the schema default keeps applying instead of a fabricated 0.
function asNumber(value) {
  if (value.trim() === '') return value
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

/**
 * A 3mf project's raw `project_settings.config` object -> a settings map this package's own API accepts.
 * Keys the config schema does not define are dropped. Returns `{settings, applied, skipped}`.
 */
export function normalizeProjectSettings(raw) {
  const settings = {}
  let applied = 0
  const skipped = []
  for (const [key, value] of Object.entries(raw || {})) {
    const type = schema[key]?.type
    if (!type) { skipped.push(key); continue }
    settings[key] = Array.isArray(value) ? value.map(entry => coerceScalar(type, entry)) : coerceScalar(type, value)
    applied++
  }
  return { settings, applied, skipped }
}

// The exact inverse, for WRITING a project_settings.config: every value back to the string shape upstream
//  serializes (bool -> "1"/"0", point -> "XxY", a points group -> "X1xY1,X2xY2"), because that is what every other
//  slicer's reader — and normalizeProjectSettings above — expects to coerce FROM. Writing the JS types raw would
//  hand OrcaSlicer a bool it reads with its own string parser and this package a round-trip that only works here.
//  Keys the schema does not define are dropped for the same reason normalize drops them: they could not be typed.
const pointToText = (point) => (Array.isArray(point) ? `${point[0]}x${point[1]}` : String(point))

function serializeScalar(type, value) {
  if (value == null) return ''
  switch (type) {
    case 'coBool': case 'coBools':
      return value ? '1' : '0'
    case 'coPoint': case 'coPoints':
      return pointToText(value)
    case 'coPointsGroups':
      return Array.isArray(value) ? value.map(pointToText).join(',') : String(value)
    default:
      return String(value)   // numbers, percents, strings, enums — String() is upstream's own spelling for all of them
  }
}

/** A settings map (real JS types) -> the all-strings object a 3mf's `project_settings.config` stores. */
export function serializeProjectSettings(settings) {
  const out = {}
  for (const [key, value] of Object.entries(settings || {})) {
    const type = schema[key]?.type
    if (!type) continue
    // A coPoint's value IS an array ([x, y]) — the generic array path would serialize its two numbers separately.
    out[key] = (type !== 'coPoint' && Array.isArray(value))
      ? value.map(entry => serializeScalar(type, entry))
      : serializeScalar(type, value)
  }
  return out
}


// Right-panel settings values -> kernel parameters (derived from schema keys)
//  opts.plate: which plate's entry to take from per-plate array options (wipe_tower_x/y — upstream coFloats,
//  one entry per plate). Defaults to 0, so every existing caller reads exactly what it always did.
export function deriveKernelParams(settings, opts) {
  const plate = opts?.plate ?? 0
  const S = k => settingScalar(settings, k)
  const num = (k, d) => { const v = Number(S(k)); return Number.isFinite(v) ? v : d }
  const bool = (k, d) => { const v = settingRaw(settings, k); return typeof v === 'boolean' ? v : (Array.isArray(v) ? !!v[0] : (v == null ? d : !!v)) }
  // Filament retraction overrides: upstream lets a material override the machine's retraction (TPU wants a
  //  different pull-back than PLA on the same printer). These schema keys are nullable and carry no default of
  //  their own — "unset" means keep the machine value — so this reads the settings map directly rather than
  //  through settingScalar, whose schema fallback would not distinguish the two.
  const override = (filamentKey, machineKey, fallback) => {
    const raw = settings?.[filamentKey]
    const value = Number(Array.isArray(raw) ? raw[0] : raw)
    return Number.isFinite(value) ? value : num(machineKey, fallback)
  }

  let line_width = num('line_width', 0); if (!line_width) line_width = 0.42   // 0=auto -> default 0.42

  let pat = String(S('sparse_infill_pattern') ?? 'rectilinear')
  if (!KERNEL_PATTERNS.includes(pat)) pat = 'rectilinear'                     // pattern unsupported by the kernel -> rectilinear

  let seam = String(S('seam_position') ?? 'back')
  if (seam === 'aligned_back') seam = 'back'
  if (!KERNEL_SEAMS.includes(seam)) seam = 'back'

  // Support style: schema enum (default/grid/snug/organic/tree_slim/tree_strong/tree_hybrid)
  //  -> kernel grid|tree|tree_lite. Since stage 18 the tree/organic family maps to the real organic TreeSupport ('tree',
  //  generate_tree_support_3D -> real type5 branch toolpaths); everything else maps to grid.
  const styleRaw = String(S('support_style') ?? 'default')
  const support_style = /tree|organic/i.test(styleRaw) ? 'tree' : 'grid'

  // Bed: bounding box of the first rectangle in printable_area
  const pa = settingRaw(settings, 'printable_area')
  let bed_width = 256, bed_depth = 256
  if (Array.isArray(pa) && pa.length) {
    const xs = pa.map(p => p[0]), ys = pa.map(p => p[1])
    bed_width = Math.max(...xs) - Math.min(...xs); bed_depth = Math.max(...ys) - Math.min(...ys)
  }

  // Stage 21: per-feature widths — passed to the kernel verbatim (including strings like "120%"). Unedited keys are omitted -> the kernel derives auto(=line_width).
  //  The 0=auto semantics are handled by the kernel's resolve_lw (upstream Flow formula). Defaults unchanged (no feature set -> line_width).
  const widths = {}
  for (const k of ['outer_wall_line_width','inner_wall_line_width','top_surface_line_width',
                   'sparse_infill_line_width','internal_solid_infill_line_width','initial_layer_line_width']) {
    const v = S(k); if (v != null && v !== '') widths[k] = v
  }
  const machine = {}
  for (const [param, [key, fallback]] of Object.entries(MACHINE_LIMITS)) machine[param] = num(key, fallback)

  // Support filament mapping: which extruder prints the support base/raft, and which prints the support interface.
  //  Upstream's "Default" is the value 0 = keep whatever tool is current, and an absent key means the same thing to
  //  the kernel (its JSON reader falls back to its own 0 default). Unmapped supports are therefore omitted rather
  //  than sent as 0, so a settings map that maps neither produces byte-for-byte the parameters it produced before
  //  these keys existed — same reason the per-feature widths above are omitted when unedited.
  const supportTools = {}
  for (const key of ['support_filament', 'support_interface_filament']) {
    const extruderIndex = num(key, 0)
    if (extruderIndex > 0) supportTools[key] = extruderIndex
  }

  // Multi-material: upstream stores every filament option as one entry per extruder (coFloats), and the material
  //  picker writes each extruder's material at its own index. Only a second entry makes these arrays appear, so a
  //  single-material slice sends exactly the keys it always did — the kernel then reads its scalars as before.
  //  A hole (a material that overrides nothing) is filled with the value tool 0 resolved to, because the kernel
  //  reads the array positionally and cannot tell "absent" from "0".
  // Prime tower keys, omitted when unset so the kernel/viewer defaults stay in charge (same rule as supportTools).
  //  wipe_tower_x/y are coFloats upstream — one entry per plate — indexed by opts.plate. A hole (null entry) means
  //  nobody chose a position for THAT plate, so the automatic placement stands there; a scalar applies to every
  //  plate (the pre-array form, kept readable so old saved settings keep meaning what they meant).
  const towerSettings = {}
  {
    const width = num('prime_tower_width', 0)
    if (width > 0) towerSettings.prime_tower_width = width
    // Read the map itself, NOT settingRaw: wipe_tower_x/y carry an upstream schema default of (15, 220), which is
    //  a coordinate off the front of a 200mm bed. Taking it as "the user chose a position" put the tower outside
    //  the plate and disabled the automatic placement entirely — measured as a tower at z=-127.5 on a 200mm bed.
    //  Absent from the map means nobody chose one, and the placement beside the model stands.
    const chosen = (key) => { const raw = settings?.[key]
      const v = Array.isArray(raw) ? raw[plate] : raw
      const n = Number(v)
      return (v != null && v !== '' && Number.isFinite(n)) ? n : null }
    const towerX = chosen('wipe_tower_x'), towerY = chosen('wipe_tower_y')
    if (towerX != null) towerSettings.prime_tower_x = towerX
    if (towerY != null) towerSettings.prime_tower_y = towerY
    // The purging volumes table (flat N×N, mm³) and its scalars. Sent verbatim — the kernel indexes it [from*N+to].
    const matrix = settingRaw(settings, 'flush_volumes_matrix')
    if (Array.isArray(matrix) && matrix.length >= 4) towerSettings.flush_volumes_matrix = matrix.map(Number)
    // Upstream defaults enable_prime_tower to false and relies on flushing into the model; the kernel defaults it
    //  to true because that was the only destination it had. Both are sent only when the map carries them, so an
    //  untouched project keeps whatever the kernel decides.
    if ('enable_prime_tower' in (settings ?? {})) towerSettings.enable_prime_tower = !!settings.enable_prime_tower
    if ('flush_into_infill' in (settings ?? {})) towerSettings.flush_into_infill = !!settings.flush_into_infill
    const multiplier = num('flush_multiplier', 0)
    if (multiplier > 0) towerSettings.flush_multiplier = multiplier
    const prime = num('prime_volume', 0)
    if (prime > 0) towerSettings.prime_volume = prime
  }

  // Pass-through parameters (see PASSTHROUGH_* above). `present` reads the settings MAP, not settingRaw, because
  //  settingRaw's schema fallback is exactly what must not happen here — an unedited key has to stay absent.
  const passthrough = {}
  {
    const present = (key) => settings != null && key in settings && settings[key] != null && settings[key] !== ''
    for (const key of PASSTHROUGH_NUM) {
      if (!present(key)) continue
      const value = Number(S(key))
      if (Number.isFinite(value)) passthrough[key] = value
    }
    for (const key of PASSTHROUGH_BOOL) if (present(key)) passthrough[key] = bool(key, false)
    for (const key of PASSTHROUGH_NUM_VECTOR) {
      if (!present(key)) continue
      const raw = settings[key]
      passthrough[key] = (Array.isArray(raw) ? raw : [raw]).map(entry => { const n = Number(entry); return Number.isFinite(n) ? n : 0 })
    }
    for (const key of PASSTHROUGH_STR_VECTOR) {
      if (!present(key)) continue
      const raw = settings[key]
      passthrough[key] = (Array.isArray(raw) ? raw : [raw]).map(entry => String(entry ?? ''))
    }
    // support_line_width is coFloatOrPercent, but the kernel reads it with the plain number reader rather than the
    //  percent-aware jwidth_raw the per-feature widths get. A "120%" would reach strtod as a quoted string and
    //  parse to 0 == auto — the setting silently ignored. Resolved here against the nozzle, which is the same
    //  thing jwidth_raw does for the widths that do get the percent-aware reader.
    if (present('support_line_width')) {
      const text = String(settingScalar(settings, 'support_line_width')).trim()
      const width = text.endsWith('%') ? (parseFloat(text) / 100) * num('nozzle_diameter', 0.4) : Number(text)
      if (Number.isFinite(width) && width > 0) passthrough.support_line_width = width
    }
  }

  const perExtruder = {}
  for (const [param, key, scalar] of [
    ['extruder_nozzle_temp', 'nozzle_temperature', num('nozzle_temperature', 200)],
    ['extruder_filament_diameter', 'filament_diameter', num('filament_diameter', 1.75)],
    ['extruder_flow_ratio', 'filament_flow_ratio', num('filament_flow_ratio', 1.0)],
    ['extruder_retract_length', 'filament_retraction_length', override('filament_retraction_length', 'retraction_length', 0.8)],
    ['extruder_retract_speed', 'filament_retraction_speed', override('filament_retraction_speed', 'retraction_speed', 30)],
    ['extruder_z_hop', 'filament_z_hop', override('filament_z_hop', 'z_hop', 0.4)],
  ]) {
    const raw = settings?.[key]
    if (!Array.isArray(raw) || raw.length < 2) continue
    perExtruder[param] = raw.map(v => {
      if (v == null || v === '') return scalar        // null survives a JSON round-trip; Number(null) would be 0
      const n = Number(Array.isArray(v) ? v[0] : v)
      return Number.isFinite(n) ? n : scalar
    })
  }

  return {
    ...widths,
    ...machine,
    ...passthrough,     // present only for keys the settings map actually holds (see PASSTHROUGH_* above)
    layer_height: num('layer_height', 0.2),
    first_layer_height: num('initial_layer_print_height', 0.2),
    line_width,
    wall_loops: num('wall_loops', 2),
    infill_density: num('sparse_infill_density', 20) / 100,      // % → 0~1
    sparse_infill_pattern: pat,
    infill_angle: num('infill_direction', 45),
    top_shell_layers: num('top_shell_layers', 4),
    bottom_shell_layers: num('bottom_shell_layers', 3),
    seam_position: seam,
    skirt_loops: num('skirt_loops', 1),
    skirt_distance: num('skirt_distance', 2),
    skirt_height: num('skirt_height', 1),                       // stage 33: the kernel used to hardcode the first layer
    brim_width: num('brim_width', 0),
    brim_object_gap: num('brim_object_gap', 0),                 // stage 33: the kernel used to hardcode w*0.5
    ...perExtruder,
    // Prime tower. These were the one part of multi-material the settings map could not reach: the kernel read its
    //  own prime_tower_* parameters and nothing mapped the upstream keys onto them, so the tower's size and place
    //  were whatever the viewer decided. Only sent when the user actually set them — an unset width keeps the
    //  kernel's own default, and an unset position lets the viewer's auto-placement stand.
    ...towerSettings,
    retract_length: override('filament_retraction_length', 'retraction_length', 0.8),   // vector[0]
    retraction_minimum_travel: override('filament_retraction_minimum_travel', 'retraction_minimum_travel', 2),  // stage 33: used to be the kernel constant 2.0
    gcode_resolution: num('resolution', 0.01),                  // stage 33: tree-support path simplification tolerance
    retract_speed: override('filament_retraction_speed', 'retraction_speed', 30),
    z_hop: override('filament_z_hop', 'z_hop', 0.4),
    travel_speed: num('travel_speed', 120),
    first_layer_speed: num('initial_layer_speed', 30),
    print_speed: num('outer_wall_speed', 60),
    nozzle_diameter: num('nozzle_diameter', 0.4),
    filament_diameter: num('filament_diameter', 1.75),
    flow_ratio: num('filament_flow_ratio', 1.0),
    nozzle_temp: num('nozzle_temperature', 200),
    bed_temp: num('hot_plate_temp', 45),                        // no bed_temperature key -> hot_plate_temp
    bed_width, bed_depth,
    bed_height: num('printable_height', 0),                    // 0 = profile states no ceiling -> kernel skips the check
    // Explicitly-set only: the schema default here is upstream's generic "G28 / G1 Z5" preamble, and falling back
    //  to it would rewrite the emitted G-code for every caller. The kernel keeps its own preamble when these are empty.
    machine_start_gcode: String(settings?.machine_start_gcode ?? ''),
    machine_end_gcode: String(settings?.machine_end_gcode ?? ''),
    enable_support: bool('enable_support', false),
    support_threshold_angle: num('support_threshold_angle', 30),
    support_top_z_distance: num('support_top_z_distance', 0.2),
    support_bottom_z_distance: num('support_bottom_z_distance', 0.2),   // stage 32: support bottom z-gap (default 0.2 = equivalent to current behavior)
    support_xy_distance: num('support_object_xy_distance', 0.35),
    support_interface_top_layers: num('support_interface_top_layers', 2),
    // Stage 33: support keys added when the kernel hardcoding was removed (upstream schema key names kept)
    support_angle: num('support_angle', 0),
    support_base_pattern: String(S('support_base_pattern') ?? 'default'),
    support_interface_pattern: String(S('support_interface_pattern') ?? 'auto'),
    support_interface_spacing: num('support_interface_spacing', 0.5),
    support_base_pattern_spacing: num('support_base_pattern_spacing', 2.5),
    support_remove_small_overhang: bool('support_remove_small_overhang', true),
    bridge_no_support: bool('bridge_no_support', false),
    support_expansion: num('support_expansion', 0),
    support_threshold_overlap: (() => { const v = settingRaw(settings, 'support_threshold_overlap')
      if (typeof v === 'string' && v.trim().endsWith('%')) return parseFloat(v) / 100
      const n = Number(v); return Number.isFinite(n) ? n : 0.5 })(),   // "50%" -> 0.5 (ratio of extrusion width)
    support_on_build_plate_only: bool('support_on_build_plate_only', false),
    support_interface_bottom_layers: num('support_interface_bottom_layers', 0),
    ...supportTools,                                            // present only when a support extruder is mapped (see above)
    raft_layers: num('raft_layers', 0),
    raft_expansion: num('raft_expansion', 1.5),                 // stage 33: the kernel used to hardcode +3.0
    raft_contact_distance: num('raft_contact_distance', 0.1),   // stage 33: previously ignored by the kernel
    fan_speed: num('fan_max_speed', 100),                       // no fan_speed key -> fan_max_speed
    close_fan_the_first_x_layers: num('close_fan_the_first_x_layers', 1),
    full_fan_speed_layer: num('full_fan_speed_layer', 0),
    slow_down_layer_time: num('slow_down_layer_time', 5),
    enable_arc_fitting: bool('enable_arc_fitting', false),
    spiral_mode: bool('spiral_mode', false),
    // New in stage 5 (derived from the matching schema keys)
    seam_slope_type: String(S('seam_slope_type') ?? 'none'),      // none|external|all -> scarf seam
    enable_pressure_advance: bool('enable_pressure_advance', false),
    pressure_advance: num('pressure_advance', 0.02),
    support_style,                                                 // grid|tree_lite (mapped above)
    bridge_speed: num('bridge_speed', 25),
    // New in stage 6 (derived from the matching schema keys). The MM parameters (extruder_count/mm_group_split) are
    //  injected at onSlice time from the viewer's per-object extruder assignment (not included here).
    ironing_type: String(S('ironing_type') ?? 'no ironing'),       // no ironing|top|topmost|solid (the top family = on)
    ironing_spacing: num('ironing_spacing', 0.1),
    ironing_flow: num('ironing_flow', 10),
    ironing_speed: num('ironing_speed', 20),
    reduce_crossing_wall: bool('reduce_crossing_wall', false),
    max_volumetric_extrusion_rate_slope: num('max_volumetric_extrusion_rate_slope', 0),
    // Stage 7: wall generator classic|arachne (arachne = the real ported OrcaSlicer WallToolPaths, variable width)
    wall_generator: (String(S('wall_generator') ?? 'classic') === 'arachne') ? 'arachne' : 'classic',
    // support_density has no matching schema key, so the kernel default (0.15) is used; scarf_length likewise uses the kernel default (10mm)
  }
}

// ---- Preset files (the .json OrcaSlicer imports/exports) ----------------------------------------------------
// Re-exported here rather than given their own subpath: they are settings-map transforms like the 3mf project
//  codecs above, and a consumer that has one hand on `settings` should not need a second import path for them.
export { writePresetFile, readPresetFile, presetFileText, presetOptionKeys } from './preset_file.js'
