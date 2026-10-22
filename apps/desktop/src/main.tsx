import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// A packaged build has no use for the webview context menu: it only offers
// reload and inspect, and reload would drop unsaved state mid-task. The dev
// server keeps it so the browser's own tools stay reachable.
if (import.meta.env.PROD) {
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
  })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
