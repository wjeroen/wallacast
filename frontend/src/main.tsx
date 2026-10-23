import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/monomaniac-one/latin-400.css' // wordmark font, see .app-header h1
import '@fontsource/quicksand/700.css' // wordmark fallback
import './index.css'
import App from './App.tsx'
import { startDesktopFit } from './desktop-fit'

// Chrome's desktop mode on a phone: zoom the page back to the screen's width
startDesktopFit()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register service worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
        console.log('Service Worker registered successfully:', registration.scope)
      })
      .catch((error) => {
        console.log('Service Worker registration failed:', error)
      })
  })
}
