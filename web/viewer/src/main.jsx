import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './App.jsx'
import './step_loader.js'   // registers the .step/.stp loader (the OCCT WASM only loads when such a file is actually opened)
import './styles.css'

// ponytail: HashRouter — with static hosting it opens anywhere without server configuration
ReactDOM.createRoot(document.getElementById('root')).render(
  <RouterProvider router={createBrowserRouter(routes)} />
)
