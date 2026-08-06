import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './App.jsx'
import './step_loader.js'   // .step/.stp 로더 등록 (OCCT WASM 은 실제로 열 때만 로드)
import './styles.css'

// ponytail: HashRouter — 정적 서빙이면 서버 설정 없이 어디서든 열린다
ReactDOM.createRoot(document.getElementById('root')).render(
  <RouterProvider router={createBrowserRouter(routes)} />
)
