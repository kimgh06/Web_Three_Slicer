import { settingRaw } from 'three-slicer/settings'
import { schema } from 'three-slicer/data'
import { effectiveSettings, writePlateOverride } from './plate_settings.js'

// The Objects card's support state, PLATE-scoped since the multi-printer stage: the card's controls always
// mean "this plate" (the plate group header is the context), so reads come from the plate's effective map and
// writes land in its own override — the Process card keeps the global/scoped editing path. With one plate the
// write goes to the global map, exactly the pre-feature behaviour.
export function makeSupportSettings({ settings, plateSettings, setPlateSettings, setSettings, plateCount, selectedPlate }) {
  const effective = effectiveSettings(settings, plateSettings, selectedPlate)
  const writePlateKey = (plate, key, value) => plateCount > 1
    ? setPlateSettings(ps => { const before = effectiveSettings(settings, ps, plate); return writePlateOverride(ps, plate, before, { ...before, [key]: value }) })
    : setSettings(s => ({ ...s, [key]: value }))
  return {
    writePlateKey,
    onToggleSupport: (e) => writePlateKey(selectedPlate, 'enable_support', e.target.checked),
    supportOn: !!settingRaw(effective, 'enable_support'),
    supportOnOf: (plate) => !!effectiveSettings(settings, plateSettings, plate).enable_support,
    // Support style options come from the schema enum, so the list stays whatever upstream defines.
    supportStyles: (schema.support_style?.enum_values ?? [])
      .map((value, i) => ({ value, label: schema.support_style?.enum_labels?.[i] ?? value })),
    supportStyle: String(settingRaw(effective, 'support_style') ?? 'default'),
    // Both upstream coInt keys where 0 means "Default — keep whatever tool is loaded"; deriveKernelParams
    // omits them entirely at 0, so leaving the selects alone produces the same kernel params as before.
    supportFilament: Number(settingRaw(effective, 'support_filament')) || 0,
    supportInterfaceFilament: Number(settingRaw(effective, 'support_interface_filament')) || 0,
    overhangAngle: Number(settingRaw(effective, 'support_threshold_angle')) || 30,
  }
}
