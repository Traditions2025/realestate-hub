// Central feedback layer (Design Upgrade Plan, Phase 1).
//   toast / notify  — Sonner toasts replace every alert(): say WHAT happened
//                     ("Lead saved", "Text queued to 14 people"), never "Success!".
//   confirmDialog() — promise-based confirm replacing native confirm(): the title
//                     states the action, the body states the consequence, the
//                     destructive button is red and right-aligned, Cancel is the
//                     safe default, Escape cancels, Enter does NOT confirm.
import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export { toast }

// Classify a legacy alert message so swept call sites keep sensible semantics.
export function notify(msg) {
  const s = String(msg == null ? '' : msg)
  if (/^\s*(✓|✅)|\b(saved|sent|queued|added|created|updated|deleted|removed|done|complete)/i.test(s) && !/fail|error|could not|couldn'?t|⚠|✗/i.test(s)) return toast.success(s.replace(/^\s*[✓✅]\s*/, ''))
  if (/fail|error|could not|couldn'?t|denied|invalid|missing|not found|⚠|✗|unable/i.test(s)) return toast.error(s.replace(/^\s*[⚠✗]\s*/, ''))
  return toast(s)
}

// Inline failure path for PAGE LOADS (design plan 4.6): actions toast, but a
// list that failed to load needs a banner where the data should be + a retry.
export function LoadErrorBanner({ onRetry, what = 'this page' }) {
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', padding: '12px 16px', margin: '12px 0', background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)', borderRadius: 10, fontSize: 13.5 }}>
      <span>Couldn't load {what}. Check your connection — the Hub retries nothing on its own.</span>
      <button className="btn btn-secondary btn-sm" onClick={onRetry} style={{ flexShrink: 0 }}>Retry</button>
    </div>
  )
}

// ---- imperative confirm ----------------------------------------------------
let _openConfirm = null
export function confirmDialog(opts) {
  // Legacy string messages: first line becomes the title, the rest the body.
  let o = opts || {}
  if (typeof opts === 'string') {
    const [head, ...rest] = String(opts).split('\n')
    o = { title: head.trim(), body: rest.join('\n').trim() }
  }
  if (!_openConfirm) return Promise.resolve(window.confirm(o.title + (o.body ? `\n\n${o.body}` : '')))   // host not mounted (tests) — degrade to native
  return _openConfirm(o)
}

export function ConfirmHost() {
  const [state, setState] = useState(null)   // { title, body, confirmLabel, danger, resolve }
  const cancelRef = useRef(null)
  useEffect(() => {
    _openConfirm = (o) => new Promise(resolve => setState({
      title: o.title || 'Are you sure?', body: o.body || '',
      confirmLabel: o.confirmLabel || 'Confirm', danger: o.danger !== false, resolve,
    }))
    return () => { _openConfirm = null }
  }, [])
  useEffect(() => { if (state && cancelRef.current) cancelRef.current.focus() }, [state])
  if (!state) return null
  const finish = (ok) => { state.resolve(ok); setState(null) }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(false) }
    if (e.key === 'Enter') e.preventDefault()   // never confirm destructive actions on Enter
  }
  return (
    <div onKeyDown={onKey} onClick={() => finish(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="alertdialog" aria-modal="true" aria-label={state.title} onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', width: '100%', maxWidth: 400, boxShadow: '0 20px 50px rgba(0,0,0,.35)' }}>
        <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: state.body ? 6 : 14 }}>{state.title}</div>
        {state.body && <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>{state.body}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button ref={cancelRef} className="btn btn-secondary" onClick={() => finish(false)}>Cancel</button>
          <button className="btn" onClick={() => finish(true)}
            style={state.danger ? { background: '#dc2626', borderColor: '#dc2626', color: '#fff', fontWeight: 600 } : { background: 'var(--accent)', color: '#241a04', fontWeight: 600 }}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
