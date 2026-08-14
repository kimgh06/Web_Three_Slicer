// printers.json — per-printer settings extracted from OrcaSlicer's resources/profiles/<Vendor>/machine/.
// Column layout: `keys` names the columns once and each entry in `sets` is a positional row, because
// repeating the key names per printer costs more than all the values together. Rows are deduplicated —
// a printer's nozzle variants usually share one row — so a printer holds an index rather than its own copy.
// Prefer `printerSettings()` from three-slicer/settings over decoding this by hand.

/** A positional row aligned to `keys`; `null` where the profile chain never set that option. */
export type PrinterRow = (unknown | null)[]

/** `[nozzle diameter, index into sets, model name without the nozzle suffix, default process preset]` */
export type PrinterEntry = [string, number, string, string]

export interface PrinterData {
  /** Option keys, in column order — the same keys the settings panel edits */
  keys: string[]
  /** Deduplicated value rows */
  sets: PrinterRow[]
  /** Vendor -> printer profile name -> entry */
  byVendor: Record<string, Record<string, PrinterEntry>>
}

declare const printers: PrinterData
export default printers
