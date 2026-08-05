import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Shadow DOM 격리 호스트 — 컴포넌트 스타일을 shadow root 에 주입해 호스트 앱 CSS 와
// 양방향 완전 차단한다 (클래스명 충돌 불가). React 17+ 는 포털 컨테이너에도 이벤트
// 리스너를 직접 붙이므로(preparePortalMount) shadow 안에서도 합성 이벤트가 정상 동작.
// 호스트 div/컨테이너는 display:contents 로 레이아웃 투명 — 자식이 종전처럼 배치된다.
//
// 포털 컨테이너는 렌더 전에 미리 만든다. shadow root 생성을 기다렸다 조건부로 포털을
// 열면 자식 ref 가 붙기 전에 자식의 mount useEffect 가 ref=null 로 소진된다
// (three.js 초기화 영구 불발). 첫 커밋부터 detached 컨테이너에 자식을 마운트하고,
// layout effect 에서 컨테이너를 shadow root 로 옮긴다 — paint 전이라 깜빡임 없음.
// (document 를 렌더 중 만지므로 SSR 불가 — Next 등에서는 ssr:false 로 로드할 것.)
export default function ShadowHost({ css, className, children }) {
  const hostRef = useRef(null)
  const [container] = useState(() => {
    const el = document.createElement('div')
    el.style.display = 'contents'
    return el
  })
  useLayoutEffect(() => {
    const host = hostRef.current
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
    let style = shadow.querySelector('style[data-ts-css]')
    if (!style) { style = document.createElement('style'); style.setAttribute('data-ts-css', ''); shadow.append(style) }
    style.textContent = css
    if (!shadow.contains(container)) shadow.append(container)
  }, [css, container])
  return <div ref={hostRef} className={className}>{createPortal(children, container)}</div>
}
