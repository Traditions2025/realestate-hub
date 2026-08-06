import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import RichTextEditor from '../components/RichTextEditor'

const EMPTY_ACCOUNT = { name: '', title: '', phone: '', email: '', brokerage: '' }

// one labeled input for the Business Registration grid
function bfield(label, key, business, bf, fld, span) {
  return (
    <label key={key} style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)', ...(span ? { gridColumn: span } : {}) }}>{label}
      <input style={fld} value={business[key] || ''} onChange={e => bf(key, e.target.value)} />
    </label>
  )
}

// Prefill from the Twilio A2P Business Information screen (editable, first-load only).
// NOTE: the source screen showed phone "(131) 943-1585" — (131) is not a valid US
// area code; prefilled as (319), Cedar Rapids. Verify before submitting to Twilio.
const DEFAULT_BUSINESS = {
  business_name: 'Traditions Real Estate Inc', business_type: 'Corporation', website: 'http://mattsmithteam.com',
  address1: '5235 Buffalo Ridge Dr', address2: '', city: 'Cedar Rapids', state: 'IA', zip: '52411', country: 'United States',
  company_status: '', ein: '20-3977636',
  poc_name: 'Matt Smith', poc_title: 'Broker Associate', poc_job_position: 'Other',
  poc_email: 'mattsmithremax@gmail.com', poc_phone: '(319) 943-1585',
}

export default function Settings() {
  const [signature, setSignature] = useState('')
  const [account, setAccount] = useState(EMPTY_ACCOUNT)
  const [business, setBusiness] = useState(DEFAULT_BUSINESS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [gmail, setGmail] = useState({ configured: false, connected: false, user: '', last_poll: null, last_error: '', imported: 0 })
  const [gmailUser, setGmailUser] = useState('')
  const [gmailPw, setGmailPw] = useState('')
  const [gmailBusy, setGmailBusy] = useState(false)

  const loadGmail = () => authFetch('/api/settings/gmail').then(r => r.json()).then(g => { setGmail(g); setGmailUser(g.user || 'mattsmithremax@gmail.com') }).catch(() => {})
  useEffect(() => {
    authFetch('/api/settings/profile').then(r => r.json()).then(d => {
      setSignature(d.signature || '')
      setAccount({ ...EMPTY_ACCOUNT, ...(d.account || {}) })
      const b = d.business || {}
      setBusiness(Object.keys(b).length ? { ...DEFAULT_BUSINESS, ...b } : DEFAULT_BUSINESS)
    }).catch(() => {}).finally(() => setLoading(false))
    loadGmail()
  }, [])

  const connectGmail = async () => {
    if (!gmailUser.trim() || !gmailPw.trim()) { alert('Enter the Gmail address and the 16-character App Password.'); return }
    setGmailBusy(true)
    try {
      await authFetch('/api/settings/gmail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: gmailUser.trim(), app_password: gmailPw }) })
      const r = await authFetch('/api/settings/gmail/test', { method: 'POST' }).then(x => x.json())
      setGmailPw('')
      if (r.status?.connected) alert('✓ Connected to Gmail. New client emails will appear in the Inbox within a minute.')
      else alert('Saved, but connection test failed: ' + (r.status?.last_error || 'unknown') + '\n\nDouble-check the App Password (not the normal password) and that 2-Step Verification is on.')
      loadGmail()
    } catch (e) { alert('Failed: ' + e.message) } finally { setGmailBusy(false) }
  }
  const disconnectGmail = async () => {
    if (!confirm('Disconnect Gmail? Incoming emails will stop syncing to the Inbox.')) return
    await authFetch('/api/settings/gmail/disconnect', { method: 'POST' }); setGmailPw(''); loadGmail()
  }

  const save = async () => {
    setSaving(true); setSaved(false)
    try {
      await authFetch('/api/settings/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature, account, business }),
      })
      setSaved(true); setTimeout(() => setSaved(false), 2500)
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }
  const bf = (k, v) => setBusiness(b => ({ ...b, [k]: v }))

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
  const grid = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }

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

          {/* Gmail Inbox connection */}
          <section className="detail-section">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h4 style={{ margin: 0 }}>Inbox Email Connection</h4>
              {gmail.connected
                ? <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', background: 'rgba(16,185,129,0.15)', padding: '2px 8px', borderRadius: 10 }}>● Connected</span>
                : gmail.configured
                  ? <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.15)', padding: '2px 8px', borderRadius: 10 }}>⚠ Error</span>
                  : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--border)', padding: '2px 8px', borderRadius: 10 }}>Not connected</span>}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 12px' }}>
              Connect a Gmail inbox so incoming emails from your clients appear in the Inbox tab (checked every minute — no DNS needed). Uses a Google <strong>App Password</strong>, not the real password.
              <br />To make one: Google Account → <em>Security</em> → turn on <em>2-Step Verification</em> → <em>App passwords</em> → generate one for “Mail”. Paste the 16-character code below.
            </p>
            <div style={grid}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Gmail address
                <input style={fld} value={gmailUser} onChange={e => setGmailUser(e.target.value)} placeholder="mattsmithremax@gmail.com" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>App Password
                <input style={fld} type="password" value={gmailPw} onChange={e => setGmailPw(e.target.value)} placeholder={gmail.configured ? '•••••••• (saved — re-enter to change)' : 'xxxx xxxx xxxx xxxx'} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <button className="btn btn-sm btn-primary" onClick={connectGmail} disabled={gmailBusy}>{gmailBusy ? 'Connecting…' : gmail.connected ? 'Reconnect' : 'Connect'}</button>
              {gmail.configured && <button className="btn btn-sm btn-secondary" onClick={disconnectGmail} disabled={gmailBusy}>Disconnect</button>}
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {gmail.connected ? `Last checked ${gmail.last_poll ? new Date(gmail.last_poll).toLocaleTimeString() : '—'} · ${gmail.imported} imported` : gmail.last_error ? `Error: ${gmail.last_error}` : ''}
              </span>
            </div>
          </section>

          {/* Business Registration (Twilio A2P) */}
          <section className="detail-section">
            <h4 style={{ margin: 0 }}>Business Registration</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 12px' }}>
              Required by major cell carriers and Twilio (our dialer/texting provider) to verify the business and keep text messages deliverable. This is stored here so it's ready when we turn on texting.
            </p>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', margin: '4px 0 8px', fontWeight: 700 }}>General</div>
            <div style={grid}>
              {bfield('Business Name', 'business_name', business, bf, fld)}
              {bfield('Business Type', 'business_type', business, bf, fld)}
              {bfield('Website', 'website', business, bf, fld, '1 / -1')}
            </div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', margin: '14px 0 8px', fontWeight: 700 }}>Physical Address</div>
            <div style={grid}>
              {bfield('Address Line 1', 'address1', business, bf, fld, '1 / -1')}
              {bfield('Address Line 2', 'address2', business, bf, fld, '1 / -1')}
              {bfield('City', 'city', business, bf, fld)}
              {bfield('State', 'state', business, bf, fld)}
              {bfield('Zip Code', 'zip', business, bf, fld)}
              {bfield('Country', 'country', business, bf, fld)}
            </div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', margin: '14px 0 8px', fontWeight: 700 }}>Registration & Status</div>
            <div style={grid}>
              {bfield('Company Status', 'company_status', business, bf, fld)}
              {bfield('Business Registration # (EIN)', 'ein', business, bf, fld)}
            </div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', margin: '14px 0 8px', fontWeight: 700 }}>Points of Contact</div>
            <div style={grid}>
              {bfield('Name', 'poc_name', business, bf, fld)}
              {bfield('Email', 'poc_email', business, bf, fld)}
              {bfield('Title', 'poc_title', business, bf, fld)}
              {bfield('Phone Number', 'poc_phone', business, bf, fld)}
              {bfield('Job Position', 'poc_job_position', business, bf, fld)}
            </div>
          </section>

          <div>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
