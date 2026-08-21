import React, { useState } from 'react'

export default function LoginScreen({ onLogin }) {
  const [identifier, setIdentifier] = useState('')   // username or email (optional)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      // With an email → per-user login. Without → legacy shared team password.
      const body = identifier.trim() ? { email: identifier.trim(), password } : { password }
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('mst_token', data.token)
        onLogin(data.token)
      } else {
        setError(identifier.trim() ? 'Wrong email or password.' : 'Wrong password. Try again.')
      }
    } catch (err) {
      setError('Connection error. Try again.')
    }
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logo.png" alt="Matt Smith Team" className="login-logo" />
        <h2>Real Estate Hub</h2>
        <p>Sign in to continue</p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
            autoComplete="email"
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Checking...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
