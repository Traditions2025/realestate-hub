import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/app.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

// Dev responsive helper: run __overflowScan() in the console on any page/viewport to list the
// elements that stick out past the screen (the usual cause of accidental horizontal scroll).
// Intentional horizontal-scroll containers (tables, .table-scroll*) are ignored.
if (typeof window !== 'undefined') {
  window.__overflowScan = () => {
    const vw = document.documentElement.clientWidth
    const skip = /table-scroll|table-container|overflow-x|inbox-reading/
    const bad = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.right <= vw + 1) continue
      if (el.closest('.table-scroll,.table-scroll-x,.table-container')) continue
      const cls = typeof el.className === 'string' ? el.className : ''
      if (skip.test(cls)) continue
      bad.push({ el, right: Math.round(r.right), over: Math.round(r.right - vw), tag: el.tagName.toLowerCase(), cls: cls.slice(0, 60) })
    }
    bad.sort((a, b) => b.over - a.over)
    const pageOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth
    console.log(`[overflowScan] viewport ${vw}px · page overflow: ${pageOverflow} · ${bad.length} element(s) past the edge`)
    console.table(bad.slice(0, 40).map(({ el, ...r }) => r))
    bad.slice(0, 40).forEach(b => { b.el.style.outline = '2px solid red' })
    return bad
  }
}

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
