// When a settings change invalidates what is on screen — the two decisions behind use_stale_slice.js.
//
// Kept here rather than inside the hook because both are pure and both are the kind of thing that is wrong in a
// way nothing notices: too eager and the preview disappears while the user is only resizing a panel, too lax and
// the viewer keeps showing a result the settings no longer describe.

/**
 * Do two settings maps hold the same values? Compared by VALUE, not identity: a host that rebuilds its settings
 * object every render would otherwise invalidate the preview on every render.
 *
 * Arrays are compared by content for the same reason — `printable_area` is written as a fresh array whenever the
 * bed changes, so by identity alone an unchanged bed reads as a change.
 */
export function sameSettings(a, b) {
  if (a === b) return true
  const keysA = Object.keys(a ?? {}), keysB = Object.keys(b ?? {})
  if (keysA.length !== keysB.length) return false
  return keysA.every(key => {
    const left = a[key], right = b[key]
    if (Object.is(left, right)) return true
    if (Array.isArray(left) && Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right)
    return false
  })
}

/**
 * Does this cached plate result survive a settings change?
 *
 * Only an OPENED `.sl1` archive does (`stats.sla_raster`), and it is not merely allowed to but has to: importing
 * one applies the archive's own settings through `setSettings` and then populates the plate, so treating that
 * write as an invalidation would erase the result the file was opened to show.
 *
 * Everything else on a plate is a slice, and a slice describes the settings it ran with.
 */
export function survivesSettingsChange(result) {
  return !!result?.stats?.sla_raster
}
