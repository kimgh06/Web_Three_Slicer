import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router'
import { routes } from './App.jsx'
import './styles.css'

// ponytail: HashRouter — 정적 서빙이면 서버 설정 없이 어디서든 열린다
ReactDOM.createRoot(document.getElementById('root')).render(
  <RouterProvider router={createHashRouter(routes)} />
)
