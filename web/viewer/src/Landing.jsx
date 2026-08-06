import React from 'react'
import { Link } from 'react-router'
import schema from 'three-slicer/data/config-schema.json'

const OPTION_COUNT = Object.keys(schema).length

const LINKS = [
  ['npm', 'https://www.npmjs.com/package/three-slicer', '패키지'],
  ['GitHub', 'https://github.com/kimgh06/Web_Three_Slicer', '소스'],
  ['Demo', 'https://slicer.kimgh06.com/', '배포'],
]

const ROUTES = [
  ['Engine', 'three-slicer', 'Node 또는 브라우저에서 binary STL을 G-code로 슬라이스'],
  ['Settings', 'three-slicer/settings', 'OrcaSlicer 설정 map을 커널 파라미터로 변환'],
  ['Viewer', 'three-slicer/viewer', 'React 3D 뷰어, 모델 로딩, 워커 슬라이싱, 툴패스 프리뷰'],
  ['Components', 'three-slicer/components', '907개 설정 schema 기반 React SettingsPanel'],
  ['Data', 'three-slicer/data', 'config schema, UI tree, toggle rules, invalidation map'],
  ['Worker', 'three-slicer/worker', '브라우저 main thread 밖에서 layer streaming'],
]

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
        <div className="lp-kicker">three-slicer · Browser/WASM 3D printing slicer</div>
        <h1>Web Three Slicer</h1>
        <p>OrcaSlicer 기반의 WASM 슬라이싱 엔진, React 뷰어, 설정 패널을 하나의 npm 패키지로 제공합니다.</p>
        <div className="lp-cta">
          <Link className="lp-btn primary" to="/slice">슬라이서 열기</Link>
          <a className="lp-btn" href="https://www.npmjs.com/package/three-slicer" target="_blank" rel="noreferrer">npm 패키지</a>
          <a className="lp-btn" href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <nav className="lp-links" aria-label="Project links">
          {LINKS.map(([label, href, meta]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <small>{meta}</small>
            </a>
          ))}
        </nav>
      </header>

      <main>
        <section className="lp-section" aria-labelledby="install-title">
          <div className="lp-section-head">
            <h2 id="install-title">Install</h2>
            <p>Headless engine만 쓰거나, React viewer/settings UI까지 붙일 수 있습니다.</p>
          </div>
          <div className="lp-code-grid">
            <pre><code>npm i three-slicer</code></pre>
            <pre><code>npm i three-slicer react react-dom three</code></pre>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="routes-title">
          <div className="lp-section-head">
            <h2 id="routes-title">Use It As</h2>
            <p>README의 사용 경로를 그대로 따라갈 수 있도록 subpath export를 나눠 제공합니다.</p>
          </div>
          <div className="lp-route-grid">
            {ROUTES.map(([name, path, desc]) => (
              <article key={path} className="lp-route-card">
                <h3>{name}</h3>
                <code>{path}</code>
                <p>{desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-section" aria-labelledby="features-title">
          <div className="lp-section-head">
            <h2 id="features-title">Demo Surface</h2>
            <p>이 배포판은 패키지를 workspace 이름으로 소비하는 실제 브라우저 데모입니다.</p>
          </div>
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
        </section>

        <section className="lp-section lp-license" aria-label="License">
          <p>AGPL-3.0-or-later · OrcaSlicer 기반 · 서버 없이 브라우저 또는 Node에서 실행</p>
          <Link to="/slice">바로 슬라이스하기</Link>
        </section>
      </main>

      <footer className="lp-foot">
        <span>Source</span>
        <a href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">kimgh06/Web_Three_Slicer</a>
      </footer>
    </div>
  )
}
