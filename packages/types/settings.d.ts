// three-slicer/settings
import type { SlicerSettings, SettingKey, Point } from './settings-keys.d.ts'
export type { SlicerSettings, SettingKey, Point }

/** The config-schema default value (undefined for unknown keys) */
export function schemaDefault(key: string): unknown

/** Settings map first, schema default otherwise. Vector types are returned as-is. */
export function settingRaw(settings: SlicerSettings | null | undefined, key: string): unknown

/** Normalizes settingRaw to a scalar — [0] for vectors. */
export function settingScalar(settings: SlicerSettings | null | undefined, key: string): unknown

/**
 * Settings map -> kernel slice params. Derived from schema keys; missing keys are filled with internal defaults.
 * ponytail: 53 returned keys, so Record instead of listing each — kernel params are passed straight to slice(),
 * not an API consumers read field by field. Expand it when field access is actually needed.
 */
export function deriveKernelParams(settings: SlicerSettings | null | undefined): Record<string, unknown>

/**
 * A 3mf project's raw `Metadata/project_settings.config` -> a settings map this API accepts.
 * Upstream writes every option as a string ("0"/"1" for a bool, "0.2" for a float, one entry per extruder for a
 * vector); each value is coerced by its config-schema type, and keys the schema does not define are dropped into
 * `skipped` rather than carried into the map. `applied` is how many keys survived.
 */
export function normalizeProjectSettings(raw: Record<string, unknown> | null | undefined): {
  settings: SlicerSettings
  applied: number
  skipped: string[]
}

// ---- Lazily loaded presets --------------------------------------------------
// Both facades hide the column layout of the artifact they wrap; the promise is created once and reused.

export interface ProcessPresetsApi {
  /** Every key a process preset can set — clear these before applying a different one */
  keys: string[]
  /** Preset names compatible with a printer profile, in upstream order */
  listFor(printerProfileName: string): string[]
  /** The settings a preset applies, ready to merge. `null` when unknown. */
  settingsFor(presetName: string): SlicerSettings | null
}
export function processPresets(): Promise<ProcessPresetsApi>

/** A material as a picker shows it. `type`/`vendor` are `''` when the profile chain declares neither. */
export interface FilamentPreset { name: string, type: string, vendor: string }

export interface FilamentPresetsApi {
  /** Every key a filament preset can set — clear these before applying a different material */
  keys: string[]
  /** Every material in the catalog, in upstream order — for a picker shown before any printer is chosen */
  all(): FilamentPreset[]
  /** Materials compatible with a printer profile, in upstream order */
  listFor(printerProfileName: string): FilamentPreset[]
  /** The vendor's recommended materials for that printer's model — a subset of listFor */
  recommendedFor(printerProfileName: string): FilamentPreset[]
  /** The settings a material applies, ready to merge. `null` when unknown. */
  settingsFor(presetName: string): SlicerSettings | null
}
export function filamentPresets(): Promise<FilamentPresetsApi>
