import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import RichTextEditor from '../components/RichTextEditor'

const EMPTY_ACCOUNT = { name: '', title: '', phone: '', email: '', brokerage: '' }

export default function Settings() {
  const [signature, setSignature] = useState('')
  const [account, setAccount] = useState(EMPTY_ACCOUNT)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    authFetch('/api/settings/profile').then(r => r.json()).then(d => {
      setSignature(d.signature || '')
      setAccount({ ...EMPTY_ACCOUNT, ...(d.account || {}) })
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setSaving(true); setSaved(false)
    try {
      await authFetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature, account }),
      })
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }

  const buildFromAccount = () => {
    const a = account
    const line = (t) => t ? `<div>${t}</div>` : ''
    setSignature(
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">` +
      (a.name ? `<div style="font-weight:bold;">${a.name}</div>` : '') +
      line(a.title) + line(a.brokerage) +
      (a.phone ? `<div>📞 ${a.phone}</div>` : '') +
      (a.email ? `<div>✉ <a href="mailto:${a.email}" style="color:#2563eb;">${a.email}</a></div>` : '') +
      `</div>`
    )
  }

  const fld = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, width: '100%' }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="page-subtitle">Your email signature + account info — the signature appears on the emails you send.</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving || loading}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}
        </button>
      </div>

      {loading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : (
        <div style={{ display: 'grid', gap: 24, maxWidth: 760 }}>
          {/* Account info */}
          <section className="detail-section">
            <h4>Account Info</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Name
                <input style={fld} value={account.name} onChange={e => setAccount(a => ({ ...a, name: e.target.value }))} placeholder="Matt Smith" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Title
                <input style={fld} value={account.title} onChange={e => setAccount(a => ({ ...a, title: e.target.value }))} placeholder="Realtor / Team Lead" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Phone
                <input style={fld} value={account.phone} onChange={e => setAccount(a => ({ ...a, phone: e.target.value }))} placeholder="(319) 555-0100" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Email
                <input style={fld} value={account.email} onChange={e => setAccount(a => ({ ...a, email: e.target.value }))} placeholder="matt@mattsmithteam.com" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)', gridColumn: '1 / -1' }}>Brokerage
                <input style={fld} value={account.brokerage} onChange={e => setAccount(a => ({ ...a, brokerage: e.target.value }))} placeholder="RE/MAX Real Estate Concepts" />
              </label>
            </div>
          </section>

          {/* Email signature */}
          <section className="detail-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0 }}>Email Signature</h4>
              <button className="btn btn-sm btn-secondary" onClick={buildFromAccount} title="Generate a signature from the account info above">✨ Build from Account Info</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 10px' }}>This is added to the bottom of emails you compose and generate (e.g. “Homes They Viewed”).</p>
            <RichTextEditor value={signature} onChange={setSignature} minHeight={160} />
          </section>

          <div>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
