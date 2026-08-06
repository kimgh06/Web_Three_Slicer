// three-slicer/toggle — toggle-rules.json 의 enable_if 조건식 부분 평가.
import type { SlicerSettings } from './settings-keys.d.ts'

/** 설정 접근기 — 값이 없으면 스키마 default, 벡터형은 [0]. */
export interface ToggleCfg {
  bool(key: string): boolean
  int(key: string): number
  float(key: string): number
  /** 키가 config-schema 에 존재하는가 */
  has(key: string): boolean
}

export function makeCfg(settings: SlicerSettings | null | undefined): ToggleCfg

/**
 * enable_if 조건식 1개 평가. 번역 불가한 식은 `null`(= fail-open, 활성 유지) 을 돌려준다 —
 * `false` 와 반드시 구분해서 다룰 것.
 */
export function evalEnableIf(expr: string, locals: Record<string, unknown>, cfg: ToggleCfg): boolean | null

/** 현재 설정에서 비활성이어야 하는 키 → 그렇게 만든 enable_if 조건식. 조건이 명확히 false 인 규칙만. */
export function disabledKeys(cfg: ToggleCfg): Record<string, string>
