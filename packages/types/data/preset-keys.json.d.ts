// preset-keys.json — which option keys belong to which preset type, extracted from upstream's Preset.cpp
// (`s_Preset_print_options`, `s_Preset_filament_options`, and printer_options() = printer + machine limits +
// the per-extruder keys from PrintConfig.cpp).
//
// Distinct from printers.json's `keys`, which is the 21 columns the kernel reads: that is what a picker needs,
// this is what writing a preset FILE another slicer will accept needs. Keys the config schema does not define are
// dropped at extraction — every consumer coerces by schema type, so an untyped key could not be handled anyway.
// Read it through `presetOptionKeys()` in three-slicer/settings rather than indexing this by hand.

export interface PresetKeyLists {
  /** Machine preset options — upstream's `Preset::printer_options()` */
  printer: string[]
  /** Print (process) preset options */
  process: string[]
  /** Filament preset options */
  filament: string[]
}

declare const presetKeys: PresetKeyLists
export default presetKeys
