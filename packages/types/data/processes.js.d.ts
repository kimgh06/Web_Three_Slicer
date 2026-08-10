// processes.js — print (process) presets extracted from OrcaSlicer's resources/profiles/<Vendor>/process/.
// Emitted as a JS module rather than JSON because it is loaded dynamically: see engine/src/data.js for why.
// Column layout, same as printers.json — `keys` names the columns once and each row in `sets` is positional.
// Prefer `processPresets()` from three-slicer/settings over decoding this by hand.

/** A positional row aligned to `keys`; `null` where the profile chain never set that option. */
export type ProcessRow = (unknown | null)[]

export interface ProcessData {
  /** Option keys, in column order — the keys the kernel consumes, read out of engine/src/settings.js */
  keys: string[]
  /** Deduplicated value rows */
  sets: ProcessRow[]
  /** `[preset name, index into sets]`, indexed by the numbers in `byPrinter` */
  presets: [string, number][]
  /** Printer profile name -> indices into `presets` */
  byPrinter: Record<string, number[]>
}

declare const processes: ProcessData
export default processes
