// The vendor catalog, as an injectable rather than an import.
//
// The printer, process, filament and resin catalogs are extracted from OrcaSlicer's own profile bundles
// (2.0MB of curated preset values). Reaching for them by import wires the viewer to that specific data,
// which is wrong in two independent ways:
//
//  · Licensing. They are upstream's, and cannot carry a permissive license (packages/PROVENANCE.md §5).
//    The viewer has to be able to run without them for the permissive package to be possible at all.
//  · Product. An industrial adopter running its own machine fleet wants ITS profiles, not a vendor bundle,
//    and does not want to ship 2MB of presets it will never show.
//
// So the viewer asks a catalog for these, and the default catalog happens to be the bundled one. A host that
// passes its own gets its own; a host that passes an EMPTY catalog gets a viewer with no preset pickers and
// no upstream data, which is the shape the permissive package needs.
import {
  printerKeys, printerSettings, printersByVendor, printerTechByVendor, printerDefaultPreset,
  processPresets, filamentPresets, resinCatalog, resinSettingsFor,
} from 'three-slicer/settings'

/** The catalog assembled from the bundled OrcaSlicer extraction. */
export const bundledCatalog = Object.freeze({
  printerKeys,
  printerSettings,
  printersByVendor,
  printerTechByVendor,
  printerDefaultPreset,
  processPresets,
  filamentPresets,
  resinCatalog,
  resinSettingsFor,
})

/** A catalog that knows nothing: every lookup misses, every list is empty. Nothing throws — a viewer with no
 *  catalog still loads models, slices with the settings it was handed, and draws the result. */
export const emptyCatalog = Object.freeze({
  printerKeys: [],
  printerSettings: () => null,
  printersByVendor: {},
  printerTechByVendor: {},
  printerDefaultPreset: () => null,
  processPresets: async () => ({ keys: [], listFor: () => [], settingsFor: () => null }),
  filamentPresets: async () => ({ keys: [], listFor: () => [], recommendedFor: () => [], settingsFor: () => null }),
  resinCatalog: [],
  resinSettingsFor: () => null,
})

/** Fill a partial catalog from the bundled one, so a host may override a single entry without restating the
 *  rest. `null` selects the empty catalog outright — "I have no presets" is a real answer, distinct from
 *  "I did not pass anything". */
export function resolveCatalog(catalog) {
  if (catalog === null) return emptyCatalog
  if (!catalog) return bundledCatalog
  return Object.freeze({ ...bundledCatalog, ...catalog })
}
