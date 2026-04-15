import React, { useState } from 'react'

export default function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })
      const data = await res.json()

      if (data.success) {
        localStorage.setItem('mst_token', data.token)
        onLogin(data.token)
      } else {
        setError('Wrong password. Try again.')
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
        <p>Enter team password to continue</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Team password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            required
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={loading} style={{width: '100%'}}>
            {loading ? 'Checking...' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  )
}
