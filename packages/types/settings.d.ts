// three-slicer/settings
import type { SlicerSettings, SettingKey, Point } from './settings-keys.d.ts'
export type { SlicerSettings, SettingKey, Point }

/** config-schema 의 default 값 (없는 키면 undefined) */
export function schemaDefault(key: string): unknown

/** settings 맵 우선, 없으면 스키마 default. 벡터형은 벡터 그대로 돌려준다. */
export function settingRaw(settings: SlicerSettings | null | undefined, key: string): unknown

/** settingRaw 를 스칼라로 정규화 — 벡터면 [0]. */
export function settingScalar(settings: SlicerSettings | null | undefined, key: string): unknown

/**
 * 설정 맵 → 커널 슬라이스 파라미터. 스키마 키에서 유도하며 누락 키는 내부 기본값으로 채운다.
 * ponytail: 반환 키가 53개라 개별 나열 대신 Record — 커널 파라미터는 slice() 에 그대로 넘기는 용도지
 * 소비자가 필드 단위로 읽는 API 가 아니다. 필드 접근이 필요해지면 그때 펼칠 것.
 */
export function deriveKernelParams(settings: SlicerSettings | null | undefined): Record<string, unknown>
