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
  const [mailboxes, setMailboxes] = useState([])
  const [mbUser, setMbUser] = useState('')
  const [mbPw, setMbPw] = useState('')
  const [mbHost, setMbHost] = useState('imap.gmail.com')
  const [mbAdvanced, setMbAdvanced] = useState(false)
  const [mbBusy, setMbBusy] = useState(false)

  const loadMailboxes = () => authFetch('/api/settings/mailboxes').then(r => r.json()).then(d => setMailboxes(Array.isArray(d) ? d : [])).catch(() => {})
  useEffect(() => {
    authFetch('/api/settings/profile').then(r => r.json()).then(d => {
      setSignature(d.signature || '')
      setAccount({ ...EMPTY_ACCOUNT, ...(d.account || {}) })
      const b = d.business || {}
      setBusiness(Object.keys(b).length ? { ...DEFAULT_BUSINESS, ...b } : DEFAULT_BUSINESS)
    }).catch(() => {}).finally(() => setLoading(false))
    loadMailboxes()
  }, [])

  const addMailbox = async () => {
    if (!mbUser.trim() || !mbPw.trim()) { alert('Enter the email address and the 16-character App Password.'); return }
    setMbBusy(true)
    try {
      const r = await authFetch('/api/settings/mailboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: mbUser.trim(), app_password: mbPw, host: (mbHost.trim() || 'imap.gmail.com') }) }).then(x => x.json())
      setMbPw(''); setMbUser('')
      if (r.connected) alert('✓ Connected. New client emails from this inbox will appear within a minute.')
      else alert('Saved, but connection failed: ' + (r.last_error || r.error || 'unknown') + '\n\nCheck: App Password (not the normal password), 2-Step Verification on, and (for a non-Gmail address) the IMAP host under Advanced.')
      loadMailboxes()
    } catch (e) { alert('Failed: ' + e.message) } finally { setMbBusy(false) }
  }
  const testMb = async (id) => { setMbBusy(true); try { await authFetch(`/api/settings/mailboxes/${id}/test`, { method: 'POST' }) } finally { setMbBusy(false); loadMailboxes() } }
  const removeMb = async (id, user) => { if (!confirm(`Disconnect ${user}? Incoming emails from it will stop syncing to the Inbox.`)) return; await authFetch(`/api/settings/mailboxes/${id}`, { method: 'DELETE' }); loadMailboxes() }

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

          {/* Inbox email connections (multiple mailboxes) */}
          <section className="detail-section">
            <h4 style={{ margin: 0 }}>Inbox Email Connections</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 12px' }}>
              Connect one or more inboxes so incoming client emails appear in the Inbox tab (checked every minute, no DNS). Each inbox is read <strong>directly</strong> — no forwarding — and <strong>only client-matched emails</strong> are shown, so promotional mail never clutters the Hub. Uses a Google <strong>App Password</strong> (Security → 2-Step Verification → App passwords → “Mail”), not the real password.
            </p>

            {mailboxes.length > 0 && (
              <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
                {mailboxes.map(mb => (
                  <div key={mb.id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{mb.user}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {mb.host !== 'imap.gmail.com' ? `${mb.host} · ` : ''}
                        {mb.connected ? `last checked ${mb.last_poll ? new Date(mb.last_poll).toLocaleTimeString() : '—'} · ${mb.imported} imported` : (mb.last_error ? `Error: ${mb.last_error}` : 'not checked yet')}
                      </div>
                    </div>
                    {mb.connected
                      ? <span style={{ fontSize: 11, fontWeight: 700, color: '#10b981', background: 'rgba(16,185,129,0.15)', padding: '2px 8px', borderRadius: 10 }}>● Connected</span>
                      : <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.15)', padding: '2px 8px', borderRadius: 10 }}>⚠ Error</span>}
                    <button className="btn btn-sm btn-secondary" onClick={() => testMb(mb.id)} disabled={mbBusy}>Test</button>
                    <button className="btn btn-sm btn-danger" onClick={() => removeMb(mb.id, mb.user)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, margin: '4px 0 8px' }}>Add a mailbox</div>
            <div style={grid}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Email address
                <input style={fld} value={mbUser} onChange={e => setMbUser(e.target.value)} placeholder="matt@mattsmithteam.com" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>App Password
                <input style={fld} type="password" value={mbPw} onChange={e => setMbPw(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
              </label>
            </div>
            {mbAdvanced && (
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>IMAP host (only if not Gmail/Workspace)
                <input style={fld} value={mbHost} onChange={e => setMbHost(e.target.value)} placeholder="imap.gmail.com" />
              </label>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <button className="btn btn-sm btn-primary" onClick={addMailbox} disabled={mbBusy}>{mbBusy ? 'Connecting…' : '+ Connect mailbox'}</button>
              <button className="btn btn-sm btn-secondary" onClick={() => setMbAdvanced(a => !a)}>{mbAdvanced ? 'Hide advanced' : 'Advanced'}</button>
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
