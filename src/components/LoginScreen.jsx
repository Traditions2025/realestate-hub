import React, { useState } from 'react'
import PasswordField from './PasswordField'

export default function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('login')   // 'login' | 'forgot'
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const body = identifier.trim() ? { email: identifier.trim(), password } : { password }
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (data.success) { localStorage.setItem('mst_token', data.token); onLogin(data.token) }
      else setError(identifier.trim() ? 'Wrong email or password.' : 'Wrong password. Try again.')
    } catch { setError('Connection error. Try again.') }
    setLoading(false)
  }

  const handleForgot = async (e) => {
    e.preventDefault()
    setError(''); setNotice(''); setLoading(true)
    try {
      await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: identifier.trim() }) })
      setNotice('If that email is on an account, a reset link is on its way. Check your inbox.')
    } catch { setError('Connection error. Try again.') }
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logo.png" alt="Matt Smith Team" className="login-logo" />
        <h2>Real Estate Hub</h2>
        {mode === 'login' ? (
          <>
            <p>Sign in to continue</p>
            <form onSubmit={handleLogin}>
              <input type="email" placeholder="Email" value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="email" autoFocus />
              <PasswordField value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" autoComplete="current-password" required />
              {error && <div className="login-error">{error}</div>}
              <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%' }}>{loading ? 'Checking...' : 'Sign in'}</button>
            </form>
            <button type="button" onClick={() => { setMode('forgot'); setError(''); setNotice('') }}
              style={{ marginTop: 12, background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13 }}>
              Forgot password?
            </button>
          </>
        ) : (
          <>
            <p>Enter your email and we'll send you a reset link</p>
            <form onSubmit={handleForgot}>
              <input type="email" placeholder="Email" value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="email" autoFocus required />
              {error && <div className="login-error">{error}</div>}
              {notice && <div style={{ color: '#10b981', fontSize: 13, margin: '8px 0' }}>{notice}</div>}
              <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%' }}>{loading ? 'Sending...' : 'Send reset link'}</button>
            </form>
            <button type="button" onClick={() => { setMode('login'); setError(''); setNotice('') }}
              style={{ marginTop: 12, background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13 }}>
              ← Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  )
}
