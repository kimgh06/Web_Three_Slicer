export const SLA_JOB_VERSION = 1

export const SLA_CAPABILITIES = Object.freeze({
  defaultSupport: 'wasm-required',
  branchingSupport: 'wasm-required',
  organicSupport: 'unsupported',
  manualSupportPoints: 'wasm-required',
  modifierVolumes: 'wasm-required',
  pad: 'wasm-required',
  correction: 'wasm-required',
  hollowing: 'unsupported',
  drainHoles: 'unsupported',
  jsFallback: 'single-object-contours-only',
})

export class SlaRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SlaRequestError'
    this.code = code
  }
}

const fail = (code, message) => { throw new SlaRequestError(code, message) }
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)
const isBinary = (value) => value instanceof ArrayBuffer || value instanceof Uint8Array
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const nonEmptyText = (value) => typeof value === 'string' && value.length > 0
const optionalRecord = (value, path) => {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', `${path} must be an object`)
  return value
}

const matrixOf = (value, path) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length !== 16 || value.some(v => !finite(v)))
    fail('SLA_INVALID_REQUEST', `${path} must be 16 finite numbers`)
  return value
}

const isIdentity = (matrix) => !matrix || matrix.every((value, index) => value === (index % 5 === 0 ? 1 : 0))

const pointOf = (value, path) => {
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', `${path} must be an object`)
  if (!['manual', 'automatic', 'island', 'slope'].includes(value.type))
    fail('SLA_INVALID_REQUEST', `${path}.type must be 'manual', 'automatic', 'island', or 'slope'`)
  if (!Array.isArray(value.position) || value.position.length !== 3 || value.position.some(v => !finite(v)))
    fail('SLA_INVALID_REQUEST', `${path}.position must be three finite numbers`)
  for (const key of ['radius', 'elevation'])
    if (has(value, key) && (!finite(value[key]) || value[key] < 0)) fail('SLA_INVALID_REQUEST', `${path}.${key} must be a non-negative finite number`)
  for (const key of ['permanent', 'manual'])
    if (has(value, key) && typeof value[key] !== 'boolean') fail('SLA_INVALID_REQUEST', `${path}.${key} must be boolean`)
  return value
}

const drainHoleOf = (value, path) => {
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', `${path} must be an object`)
  for (const key of ['position', 'normal'])
    if (!Array.isArray(value[key]) || value[key].length !== 3 || value[key].some(v => !finite(v)))
      fail('SLA_INVALID_REQUEST', `${path}.${key} must be three finite numbers`)
  for (const key of ['radius', 'height'])
    if (!finite(value[key]) || value[key] < 0) fail('SLA_INVALID_REQUEST', `${path}.${key} must be a non-negative finite number`)
  return value
}

const modifierOf = (value, path) => {
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', `${path} must be an object`)
  if (!nonEmptyText(value.id)) fail('SLA_INVALID_REQUEST', `${path}.id must be a non-empty string`)
  if (value.kind !== 'blocker' && value.kind !== 'enforcer') fail('SLA_INVALID_REQUEST', `${path}.kind must be 'blocker' or 'enforcer'`)
  if (!isBinary(value.stl)) fail('SLA_INVALID_REQUEST', `${path}.stl must be an ArrayBuffer or Uint8Array`)
  matrixOf(value.transform, `${path}.transform`)
  optionalRecord(value.settings, `${path}.settings`)
  return value
}

const instanceOf = (value, path) => {
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', `${path} must be an object`)
  if (!nonEmptyText(value.id)) fail('SLA_INVALID_REQUEST', `${path}.id must be a non-empty string`)
  matrixOf(value.transform, `${path}.transform`)
  optionalRecord(value.settings, `${path}.settings`)
  return value
}

const objectOf = (value, index, ids) => {
  const path = `objects[${index}]`
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', `${path} must be an object`)
  if (!nonEmptyText(value.id) || ids.has(value.id)) fail('SLA_INVALID_REQUEST', `${path}.id must be a unique non-empty string`)
  if (!isBinary(value.stl)) fail('SLA_INVALID_REQUEST', `${path}.stl must be an ArrayBuffer or Uint8Array`)
  ids.add(value.id)
  matrixOf(value.transform, `${path}.transform`)
  optionalRecord(value.settings, `${path}.settings`)
  if (value.instances !== undefined) {
    if (!Array.isArray(value.instances) || value.instances.length === 0) fail('SLA_INVALID_REQUEST', `${path}.instances must be a non-empty array when present`)
    const instanceIds = new Set()
    value.instances.forEach((instance, i) => {
      instanceOf(instance, `${path}.instances[${i}]`)
      if (instanceIds.has(instance.id)) fail('SLA_INVALID_REQUEST', `${path}.instances ids must be unique`)
      instanceIds.add(instance.id)
    })
  }
  if (value.supportPoints !== undefined) {
    if (!Array.isArray(value.supportPoints)) fail('SLA_INVALID_REQUEST', `${path}.supportPoints must be an array`)
    value.supportPoints.forEach((point, i) => pointOf(point, `${path}.supportPoints[${i}]`))
  }
  if (value.modifierVolumes !== undefined) {
    if (!Array.isArray(value.modifierVolumes)) fail('SLA_INVALID_REQUEST', `${path}.modifierVolumes must be an array`)
    value.modifierVolumes.forEach((modifier, i) => modifierOf(modifier, `${path}.modifierVolumes[${i}]`))
  }
  if (value.drainHoles !== undefined) {
    if (!Array.isArray(value.drainHoles)) fail('SLA_INVALID_REQUEST', `${path}.drainHoles must be an array`)
    value.drainHoles.forEach((hole, i) => drainHoleOf(hole, `${path}.drainHoles[${i}]`))
  }
  return value
}

const supportOf = (value) => {
  const support = optionalRecord(value, 'support')
  if (!support) return undefined
  if (has(support, 'enabled') && typeof support.enabled !== 'boolean') fail('SLA_INVALID_REQUEST', 'support.enabled must be boolean')
  if (has(support, 'enforcersOnly') && typeof support.enforcersOnly !== 'boolean') fail('SLA_INVALID_REQUEST', 'support.enforcersOnly must be boolean')
  if (has(support, 'strategy') && !['default', 'branching', 'organic'].includes(support.strategy))
    fail('SLA_INVALID_REQUEST', "support.strategy must be 'default', 'branching', or 'organic'")
  if (support.strategy === 'organic') fail('SLA_UNSUPPORTED_ORGANIC', 'Organic SLA supports are not available')
  return support
}

const hollowingOf = (value) => {
  const hollowing = optionalRecord(value, 'hollowing')
  if (!hollowing) return undefined
  if (has(hollowing, 'enabled') && typeof hollowing.enabled !== 'boolean') fail('SLA_INVALID_REQUEST', 'hollowing.enabled must be boolean')
  if (hollowing.enabled) fail('SLA_UNSUPPORTED_HOLLOWING', 'SLA hollowing is not available')
  return hollowing
}

export function parseSlaJob(value) {
  if (!isRecord(value)) fail('SLA_INVALID_REQUEST', 'SLA job must be an object')
  if (has(value, 'version') && value.version !== SLA_JOB_VERSION) fail('SLA_INVALID_REQUEST', `SLA job version must be ${SLA_JOB_VERSION}`)
  if (!Array.isArray(value.objects) || value.objects.length === 0) fail('SLA_INVALID_REQUEST', 'SLA job.objects must be a non-empty array')
  const ids = new Set()
  value.objects.forEach((object, index) => objectOf(object, index, ids))
  if (value.objects.some(object => object.drainHoles?.length))
    fail('SLA_UNSUPPORTED_HOLLOWING', 'SLA drain holes were preserved but require unsupported hollowing geometry')
  optionalRecord(value.settings, 'settings')
  const support = supportOf(value.support)
  const pad = optionalRecord(value.pad, 'pad')
  const correction = optionalRecord(value.correction, 'correction')
  const hollowing = hollowingOf(value.hollowing)
  if (value.drainHoles !== undefined) {
    if (!Array.isArray(value.drainHoles)) fail('SLA_INVALID_REQUEST', 'drainHoles must be an array')
    if (value.drainHoles.length) fail('SLA_UNSUPPORTED_HOLLOWING', 'SLA drain holes require unsupported hollowing geometry')
  }
  if (value.requiredCapabilities !== undefined) {
    if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.some(key => !has(SLA_CAPABILITIES, key)))
      fail('SLA_INVALID_REQUEST', 'requiredCapabilities must name known SLA capabilities')
    if (value.requiredCapabilities.includes('organicSupport')) fail('SLA_UNSUPPORTED_ORGANIC', 'Organic SLA supports are not available')
    if (value.requiredCapabilities.includes('hollowing') || value.requiredCapabilities.includes('drainHoles'))
      fail('SLA_UNSUPPORTED_HOLLOWING', 'SLA hollowing is not available')
  }
  return { version: SLA_JOB_VERSION, ...value, support, pad, correction, hollowing }
}

const wantsSupports = (job, object) => job.support?.enabled === true || job.settings?.supports_enable === true || object.settings?.supports_enable === true
const wantsPad = (job, object) => job.pad?.enabled === true || job.settings?.pad_enable === true || object.settings?.pad_enable === true

export function slaFallbackParams(job) {
  if (job.objects.length !== 1) fail('SLA_FALLBACK_MULTI_OBJECT', 'The JS SLA fallback accepts exactly one object; object-aware jobs require WASM support')
  const object = job.objects[0]
  if (!isIdentity(object.transform) || object.instances !== undefined || object.supportPoints?.length || object.modifierVolumes?.length || object.settings?.hollowing_enable === true)
    fail('SLA_FALLBACK_OBJECT_CONTEXT', 'The JS SLA fallback cannot preserve object transforms, instances, points, modifiers, or hollowing')
  if (wantsSupports(job, object)) fail('SLA_FALLBACK_SUPPORTS', 'The JS SLA fallback cannot generate requested supports')
  if (wantsPad(job, object)) fail('SLA_FALLBACK_PAD', 'The JS SLA fallback cannot generate a requested pad')
  if (job.correction || job.hollowing || job.drainHoles?.length)
    fail('SLA_FALLBACK_OBJECT_CONTEXT', 'The JS SLA fallback cannot apply correction, hollowing, or drain-hole context')
  return { stl: object.stl, params: { ...(job.settings ?? {}), ...(object.settings ?? {}) } }
}

export function assertLegacySlaFallback(params) {
  if (!isRecord(params)) fail('SLA_INVALID_REQUEST', 'legacy SLA params must be an object')
  if (params.support_tree_type === 'organic') fail('SLA_UNSUPPORTED_ORGANIC', 'Organic SLA supports are not available')
  if (params.hollowing_enable === true) fail('SLA_UNSUPPORTED_HOLLOWING', 'SLA hollowing is not available')
  if (params.supports_enable === true) fail('SLA_FALLBACK_SUPPORTS', 'The JS SLA fallback cannot generate requested supports')
  if (params.pad_enable === true) fail('SLA_FALLBACK_PAD', 'The JS SLA fallback cannot generate a requested pad')
}
