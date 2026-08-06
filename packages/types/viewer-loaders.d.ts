// three-slicer/viewer/loaders — 커널 무관 순수 로더.

/** 내장 5종 + `registerLoader()` 로 등록된 확장자. 등록 시 이 배열에 push 된다. */
export const SUPPORTED_EXT: string[]

/** 소문자 확장자. 점이 없으면 빈 문자열. */
export function fileExt(name: string): string

export interface LoadedObject {
  name: string
  /** 삼각형 정점 좌표 (N*9, model z-up) */
  modelPos: Float32Array
}

/** 파일 1개에 여러 오브젝트가 들어있을 수 있다(3mf/amf/step) → 항상 배열. */
export function loadModel(name: string, buffer: ArrayBuffer): Promise<LoadedObject[]>

/**
 * 확장 포맷 등록. 무거운 의존성이 필요한 포맷(STEP=OCCT WASM 등)은 패키지에 넣지 않으므로
 * 앱에서 직접 붙인다. `<Viewport/>` 의 파일 대화상자·드래그앤드롭 필터에 자동 반영된다.
 *
 * ```js
 * import { registerLoader } from 'three-slicer/viewer/loaders'
 * registerLoader('step,stp', async (buffer, name) => [{ name, modelPos }])
 * ```
 */
export function registerLoader(
  exts: string | string[],
  fn: (buffer: ArrayBuffer, name: string) => LoadedObject[] | Promise<LoadedObject[]>,
): void

/** 연결 성분 분리. 성분이 1개뿐이면 `null`(분리 불가) — 빈 배열이 아니다. */
export function splitConnectedComponents(localPos: Float32Array): Float32Array[] | null
