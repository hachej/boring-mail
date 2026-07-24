import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@hachej/boring-workspace/globals.css'
import '@hachej/boring-agent/front/styles.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
