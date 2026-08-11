// Stage 24 toolpath renderer — the public barrel (three-slicer/viewer/toolpath).
// The implementation lives in one-job modules; this file only re-exports the surface so
// consumers and the existing tests keep a single import path.
export { TYPE_COLOR, TYPE_LABEL, TOOL_COLOR, DEFAULT_RANGES_COLORS } from './toolpath_palette.js'
export { buildSegmentData, roleRatios } from './toolpath_segments.js'
export { VIEW_TYPES, computeColors } from './toolpath_views.js'
export { VERTEX_DATA, makeToolpath } from './toolpath_mesh.js'
