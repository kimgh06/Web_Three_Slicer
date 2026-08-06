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
