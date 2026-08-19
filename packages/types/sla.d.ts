import type { SlicerSettings } from './settings-keys.d.ts'

export type SlaSupportStrategy = 'default' | 'branching' | 'organic'
export type SlaCapability = 'defaultSupport' | 'branchingSupport' | 'organicSupport' | 'manualSupportPoints' | 'modifierVolumes' | 'pad' | 'correction' | 'hollowing' | 'drainHoles'
export type SlaCapabilityStatus = 'wasm-required' | 'unsupported' | 'single-object-contours-only'
export type SlaMatrix4 = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]

export interface SlaSupportPoint {
  readonly type: 'manual' | 'automatic' | 'island' | 'slope'
  readonly position: readonly [number, number, number]
  readonly radius?: number
  readonly elevation?: number
  readonly permanent?: boolean
  readonly manual?: boolean
}

export interface SlaDrainHole {
  readonly position: readonly [number, number, number]
  readonly normal: readonly [number, number, number]
  readonly radius: number
  readonly height: number
}

export interface SlaModifierVolume {
  readonly id: string
  readonly kind: 'blocker' | 'enforcer'
  readonly stl: ArrayBuffer | Uint8Array
  readonly transform?: SlaMatrix4
  readonly settings?: SlicerSettings
}

export interface SlaObjectInstance {
  readonly id: string
  readonly transform?: SlaMatrix4
  readonly settings?: SlicerSettings
}

export interface SlaObject {
  readonly id: string
  readonly stl: ArrayBuffer | Uint8Array
  readonly transform?: SlaMatrix4
  readonly settings?: SlicerSettings
  readonly instances?: readonly SlaObjectInstance[]
  readonly supportPoints?: readonly SlaSupportPoint[]
  readonly modifierVolumes?: readonly SlaModifierVolume[]
  readonly drainHoles?: readonly SlaDrainHole[]
}

export interface SupportConfig {
  readonly enabled?: boolean
  readonly strategy?: SlaSupportStrategy
  readonly enforcersOnly?: boolean
  readonly headFrontDiameter?: number
  readonly headPenetration?: number
  readonly headWidth?: number
  readonly pillarDiameter?: number
  readonly smallPillarDiameterPercent?: number
  readonly maxBridgesOnPillar?: number
  readonly maxWeightOnModel?: number
  readonly pillarConnectionMode?: 'zigzag' | 'cross' | 'dynamic'
  readonly buildplateOnly?: boolean
  readonly pillarWideningFactor?: number
  readonly baseDiameter?: number
  readonly baseHeight?: number
  readonly baseSafetyDistance?: number
  readonly criticalAngle?: number
  readonly maxBridgeLength?: number
  readonly maxPillarLinkDistance?: number
  readonly objectElevation?: number
  readonly branchingsupport_head_front_diameter?: number
  readonly branchingsupport_head_penetration?: number
  readonly branchingsupport_head_width?: number
  readonly branchingsupport_pillar_diameter?: number
  readonly branchingsupport_small_pillar_diameter_percent?: number
  readonly branchingsupport_max_bridges_on_pillar?: number
  readonly branchingsupport_max_weight_on_model?: number
  readonly branchingsupport_pillar_connection_mode?: 'zigzag' | 'cross' | 'dynamic'
  readonly branchingsupport_buildplate_only?: boolean
  readonly branchingsupport_pillar_widening_factor?: number
  readonly branchingsupport_base_diameter?: number
  readonly branchingsupport_base_height?: number
  readonly branchingsupport_base_safety_distance?: number
  readonly branchingsupport_critical_angle?: number
  readonly branchingsupport_max_bridge_length?: number
  readonly branchingsupport_max_pillar_link_distance?: number
  readonly branchingsupport_object_elevation?: number
}

export interface PadConfig {
  readonly enabled?: boolean
  readonly wallThickness?: number
  readonly wallHeight?: number
  readonly brimSize?: number
  readonly maxMergeDistance?: number
  readonly wallSlope?: number
  readonly aroundObject?: boolean
  readonly aroundObjectEverywhere?: boolean
  readonly objectGap?: number
  readonly objectConnectorStride?: number
  readonly objectConnectorWidth?: number
  readonly objectConnectorPenetration?: number
}

export interface SlaCorrectionConfig {
  readonly relative?: readonly [number, number]
  readonly relativeX?: number
  readonly relativeY?: number
  readonly relativeZ?: number
  readonly absolute?: number
  readonly elephantFootMinWidth?: number
  readonly zCorrectionLayers?: number
  readonly closingRadius?: number
}

export interface SlaDisplayConfig {
  readonly width?: number
  readonly height?: number
  readonly pixelsX?: number
  readonly pixelsY?: number
  readonly mirrorX?: boolean
  readonly mirrorY?: boolean
  readonly orientation?: 'landscape' | 'portrait'
  readonly gamma?: number
  readonly archiveFormat?: 'SL1'
}

export interface SlaHollowingConfig {
  readonly enabled?: boolean
  readonly minThickness?: number
  readonly quality?: number
  readonly closingDistance?: number
}

export interface SlaJob {
  readonly version?: 1
  readonly objects: readonly SlaObject[]
  readonly settings?: SlicerSettings
  readonly support?: SupportConfig
  readonly pad?: PadConfig
  readonly correction?: SlaCorrectionConfig
  readonly display?: SlaDisplayConfig
  readonly hollowing?: SlaHollowingConfig
  readonly drainHoles?: readonly unknown[]
  readonly requiredCapabilities?: readonly SlaCapability[]
}

export interface SlaCapabilities {
  readonly defaultSupport: SlaCapabilityStatus
  readonly branchingSupport: SlaCapabilityStatus
  readonly organicSupport: SlaCapabilityStatus
  readonly manualSupportPoints: SlaCapabilityStatus
  readonly modifierVolumes: SlaCapabilityStatus
  readonly pad: SlaCapabilityStatus
  readonly correction: SlaCapabilityStatus
  readonly hollowing: SlaCapabilityStatus
  readonly drainHoles: SlaCapabilityStatus
  readonly jsFallback: SlaCapabilityStatus
}

export type SlaErrorCode = 'SLA_INVALID_REQUEST' | 'SLA_UNSUPPORTED_ORGANIC' | 'SLA_UNSUPPORTED_HOLLOWING' | 'SLA_FALLBACK_MULTI_OBJECT' | 'SLA_FALLBACK_SUPPORTS' | 'SLA_FALLBACK_PAD' | 'SLA_FALLBACK_OBJECT_CONTEXT'

export class SlaRequestError extends Error {
  readonly code: SlaErrorCode
}

export const SLA_JOB_VERSION: 1
export const SLA_CAPABILITIES: SlaCapabilities
