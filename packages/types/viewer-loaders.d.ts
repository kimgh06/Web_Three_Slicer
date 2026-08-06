// three-slicer/viewer/loaders — 커널 무관 순수 로더.

export const SUPPORTED_EXT: readonly ['stl', 'obj', '3mf', 'amf', 'ply']

/** 소문자 확장자. 점이 없으면 빈 문자열. */
export function fileExt(name: string): string

export interface LoadedObject {
  name: string
  /** 삼각형 정점 좌표 (N*9, model z-up) */
  modelPos: Float32Array
}

/** 파일 1개에 여러 오브젝트가 들어있을 수 있다(3mf/amf) → 항상 배열. */
export function loadModel(name: string, buffer: ArrayBuffer): Promise<LoadedObject[]>

/** 연결 성분 분리. 성분이 1개뿐이면 `null`(분리 불가) — 빈 배열이 아니다. */
export function splitConnectedComponents(localPos: Float32Array): Float32Array[] | null
