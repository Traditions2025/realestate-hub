import React, { useState } from 'react'
import PasswordField from './PasswordField'

// Public page reached from the emailed reset link (/reset-password?token=...).
export default function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pw !== pw2) { setError('Passwords do not match.'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: pw }) })
      const data = await res.json()
      if (data.success) setDone(true)
      else setError(data.error || 'Could not reset your password.')
    } catch { setError('Connection error. Try again.') }
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logo.png" alt="Matt Smith Team" className="login-logo" />
        <h2>Reset Password</h2>
        {!token ? (
          <p style={{ color: '#ef4444' }}>This reset link is missing its token. Request a new one from the sign-in screen.</p>
        ) : done ? (
          <>
            <p style={{ color: '#10b981' }}>✓ Your password has been updated.</p>
            <a href="/" className="btn btn-primary" style={{ width: '100%', display: 'inline-block', textAlign: 'center', textDecoration: 'none' }}>Go to sign in</a>
          </>
        ) : (
          <>
            <p>Choose a new password</p>
            <form onSubmit={submit}>
              <PasswordField value={pw} onChange={e => setPw(e.target.value)} placeholder="New password (min 8 characters)" autoComplete="new-password" autoFocus required />
              <div style={{ height: 8 }} />
              <PasswordField value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" required />
              {error && <div className="login-error">{error}</div>}
              <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%' }}>{loading ? 'Saving...' : 'Set new password'}</button>
            </form>
            <a href="/" style={{ marginTop: 12, display: 'inline-block', color: '#2563eb', fontSize: 13 }}>← Back to sign in</a>
          </>
        )}
      </div>
    </div>
  )
}
