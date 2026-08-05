import React from 'react'
import { Link } from 'react-router'
import schema from '@three-slicer/data/config-schema.json'

// 데모 앱 랜딩. 기능만 단어로 나열한다 — 설명문·카드 없이 무엇이 되는지만 보여준다.
//  미구현 기능(자동 배치·방향, 컷, 불리언, 텍스트, 측정, undo/redo)은 여기 쓰지 않는다.
const OPTION_COUNT = Object.keys(schema).length

const GROUPS = [
  ['입력', ['STL', 'OBJ', '3MF', 'AMF', 'PLY', '드래그앤드롭', '다중 모델']],
  ['배치', ['이동', '회전', '스케일', '복제', '객체 분리', '바닥 정렬', '멀티 플레이트']],
  ['슬라이싱', [
    'Arachne 가변폭 벽', 'gyroid / honeycomb / crosshatch 인필',
    '트리 · 그리드 서포트', '서포트 페인팅',
    '스커트', '브림', '래프트', '아이어닝', '아크 피팅', '멀티머티리얼',
  ]],
  ['프리뷰', ['레이어 슬라이더', '단일 레이어', '트래블', '피처 / 속도 / 높이 / 폭 / 팬 / 온도 뷰']],
  ['출력', ['G-code 다운로드', '출력 시간', '필라멘트 사용량']],
  ['설정', [`${OPTION_COUNT}개 옵션`, '검색', '모드 필터']],
]

export default function Landing() {
  return (
    <div className="landing">
      <header className="lp-head">
        <h1>Web Three Slicer</h1>
        <p>브라우저에서 도는 3D 프린팅 슬라이서</p>
        <div className="lp-cta">
          <Link className="lp-btn primary" to="/slice">슬라이서 열기</Link>
          <a className="lp-btn" href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </header>

      <dl className="lp-feat">
        {GROUPS.map(([label, items]) => (
          <div key={label} className="lp-row">
            <dt>{label}</dt>
            <dd>{items.map((t, i) => (
              <span key={t}>{i > 0 && <i className="lp-dot">·</i>}{t}</span>
            ))}</dd>
          </div>
        ))}
      </dl>

      <footer className="lp-foot">
        OrcaSlicer 기반 · AGPL-3.0 · 서버 없이 브라우저에서만 동작
      </footer>
    </div>
  )
}
