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
  const [fromName, setFromName] = useState('')
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
  // Twilio texting
  const [tw, setTw] = useState({ account_sid: '', auth_token_set: false, auth_token_last4: '', from_number: '', messaging_service_sid: '', enabled: false, inbound_webhook: '' })
  const [twToken, setTwToken] = useState('')
  const [twBusy, setTwBusy] = useState(false)
  const [twStatus, setTwStatus] = useState(null)
  const loadTwilio = () => authFetch('/api/settings/twilio').then(r => r.json()).then(d => setTw(d || {})).catch(() => {})
  const saveTwilio = async () => {
    setTwBusy(true); setTwStatus(null)
    try {
      const payload = { account_sid: tw.account_sid, from_number: tw.from_number, messaging_service_sid: tw.messaging_service_sid, enabled: tw.enabled }
      if (twToken.trim()) payload.auth_token = twToken.trim()
      await authFetch('/api/settings/twilio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      setTwToken(''); await loadTwilio()
      // auto-test after saving
      const d = await authFetch('/api/settings/twilio/verify', { method: 'POST' }).then(r => r.json()); setTwStatus(d)
    } catch (e) { alert('Save failed: ' + e.message) } finally { setTwBusy(false) }
  }
  const testTwilio = async () => {
    setTwBusy(true); setTwStatus(null)
    try { setTwStatus(await authFetch('/api/settings/twilio/verify', { method: 'POST' }).then(r => r.json())) }
    catch (e) { setTwStatus({ ok: false, error: e.message }) } finally { setTwBusy(false) }
  }

  const loadMailboxes = () => authFetch('/api/settings/mailboxes').then(r => r.json()).then(d => setMailboxes(Array.isArray(d) ? d : [])).catch(() => {})
  useEffect(() => {
    authFetch('/api/settings/profile').then(r => r.json()).then(d => {
      setSignature(d.signature || '')
      setAccount({ ...EMPTY_ACCOUNT, ...(d.account || {}) })
      setFromName(d.from_name || '')
      const b = d.business || {}
      setBusiness(Object.keys(b).length ? { ...DEFAULT_BUSINESS, ...b } : DEFAULT_BUSINESS)
    }).catch(() => {}).finally(() => setLoading(false))
    loadMailboxes()
    loadTwilio()
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
        body: JSON.stringify({ signature, account, business, from_name: fromName }),
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
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 12 }

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
        <div style={{ display: 'grid', gap: 24, maxWidth: 760, width: '100%', gridTemplateColumns: 'minmax(0, 1fr)' }}>
          {/* Account info */}
          <section className="detail-section">
            <h4>Account Info</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 12, marginTop: 8 }}>
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
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Brokerage
                <input style={fld} value={account.brokerage} onChange={e => setAccount(a => ({ ...a, brokerage: e.target.value }))} placeholder="RE/MAX Real Estate Concepts" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Email “From” name
                <input style={fld} value={fromName} onChange={e => setFromName(e.target.value)} placeholder="Matt Smith" />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>The sender name recipients see (e.g. “Matt Smith”). From address stays matt@mattsmithteam.com.</span>
              </label>
            </div>
          </section>

          {/* Email signature */}
          <section className="detail-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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

          {/* Text Messaging (Twilio) */}
          <section className="detail-section">
            <h4 style={{ margin: 0 }}>Text Messaging (Twilio)</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 12px' }}>
              Connect Twilio to text clients from the Hub and get their replies in the Inbox. Your <strong>Account SID</strong> + <strong>Auth Token</strong> come from the Twilio Console; the <strong>From number</strong> is your Twilio phone number (or set a Messaging Service SID instead). Credentials are stored securely here, never in code.
            </p>
            <div style={grid}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Account SID
                <input style={fld} value={tw.account_sid || ''} onChange={e => setTw(t => ({ ...t, account_sid: e.target.value }))} placeholder="AC…" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Auth Token
                <input style={fld} type="password" value={twToken} onChange={e => setTwToken(e.target.value)} placeholder={tw.auth_token_set ? `•••• saved (…${tw.auth_token_last4})` : 'your 32-char auth token'} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>From number
                <input style={fld} value={tw.from_number || ''} onChange={e => setTw(t => ({ ...t, from_number: e.target.value }))} placeholder="+13194088407" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>Messaging Service SID (optional)
                <input style={fld} value={tw.messaging_service_sid || ''} onChange={e => setTw(t => ({ ...t, messaging_service_sid: e.target.value }))} placeholder="MG… (use instead of From)" />
              </label>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={!!tw.enabled} onChange={e => setTw(t => ({ ...t, enabled: e.target.checked }))} />
              Texting enabled
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-sm btn-primary" onClick={saveTwilio} disabled={twBusy}>{twBusy ? 'Saving…' : 'Save & Test'}</button>
              <button className="btn btn-sm btn-secondary" onClick={testTwilio} disabled={twBusy}>Test connection</button>
              {twStatus && (twStatus.ok
                ? <span style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>● Connected ({twStatus.status}){twStatus.name ? ' · ' + twStatus.name : ''}</span>
                : <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444' }}>⚠ {twStatus.error || ('code ' + twStatus.code)}</span>)}
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>
              <div><strong>Inbound webhook</strong> — in Twilio, open your number → Messaging → “A message comes in” → set to <em>Webhook (HTTP POST)</em> and paste:</div>
              <code style={{ display: 'inline-block', marginTop: 4, padding: '5px 9px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, wordBreak: 'break-all', color: 'var(--text-primary)' }}>{tw.inbound_webhook}</code>
              <div style={{ marginTop: 6 }}>That routes replies (and STOP/START opt-outs) into the Inbox automatically.</div>
            </div>
          </section>

          <CommsDiagnostics />

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

// --- Communications diagnostics + admin toggles (health check, signature, recording) ---
function CommsDiagnostics() {
  const [health, setHealth] = React.useState(undefined)
  const [busy, setBusy] = React.useState(false)
  const [sig, setSig] = React.useState(null)          // signature telemetry + prefs
  const [enforce, setEnforce] = React.useState(false)
  const [record, setRecord] = React.useState(false)
  const [mcb, setMcb] = React.useState(false)         // missed-call text-back on/off
  const [mcbMsg, setMcbMsg] = React.useState('')
  const run = async () => {
    setBusy(true)
    try {
      const [h, s] = await Promise.all([
        authFetch('/api/settings/twilio/health').then(r => r.json()),
        authFetch('/api/settings/twilio/signature').then(r => r.json()),
      ])
      setHealth(h); setSig(s)
      setEnforce(s.mode === 'enforce'); setRecord(!!s.record_calls)
      setMcb(!!s.missed_call_textback_enabled); setMcbMsg(s.missed_call_textback_message || '')
    } catch { setHealth(null) } finally { setBusy(false) }
  }
  React.useEffect(() => { run() }, [])
  const saveMode = async (patch) => { await authFetch('/api/settings/twilio/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); run() }
  const dot = { ok: '#10b981', attention: '#f59e0b', missing: '#ef4444' }
  const label = { ok: 'Healthy', attention: 'Needs attention', missing: 'Not configured' }
  return (
    <section className="detail-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ margin: 0 }}>Communications Diagnostics</h4>
        <button className="btn btn-sm btn-secondary" onClick={run} disabled={busy} style={{ marginLeft: 'auto' }}>{busy ? '…' : '↻ Re-check'}</button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 12px' }}>Live check of texting + calling configuration. No secrets are shown.</p>
      {health === undefined ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Checking…</div>
        : health === null ? <div style={{ color: '#ef4444', fontSize: 13 }}>Could not run diagnostics.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {(health.checks || []).map(c => (
              <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot[c.status], flexShrink: 0 }} />
                <span style={{ fontWeight: 600, width: 200, flexShrink: 0 }}>{c.name}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: dot[c.status], width: 120, flexShrink: 0 }}>{label[c.status]}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{c.detail}</span>
              </div>
            ))}
          </div>}

      {sig && (
        <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 12.5 }}>
          <strong>Webhook signatures:</strong> {sig.valid} valid, {sig.invalid} invalid ·{' '}
          {sig.mode === 'enforce'
            ? <span style={{ color: '#10b981', fontWeight: 700 }}>Enforcing ✓</span>
            : sig.ready_to_enforce
              ? <span style={{ color: '#10b981' }}>Ready to enforce</span>
              : <span style={{ color: 'var(--text-muted)' }}>Monitoring (need a valid webhook first)</span>}
          {sig.last_invalid_at && <span style={{ color: '#ef4444' }}> · last invalid {new Date(sig.last_invalid_at).toLocaleString()} ({sig.last_invalid_path})</span>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={enforce} onChange={e => { setEnforce(e.target.checked); saveMode({ signature_mode: e.target.checked ? 'enforce' : 'monitor' }) }} />
          Enforce webhook signatures <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(reject forged Twilio requests)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={record} onChange={e => { setRecord(e.target.checked); saveMode({ record_calls: e.target.checked }) }} />
          Record calls <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(check local consent rules first)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={mcb} onChange={e => { setMcb(e.target.checked); saveMode({ missed_call_textback: e.target.checked }) }} />
          Auto text-back on missed calls <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(texts the caller when nobody answers)</span>
        </label>
        {mcb && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingLeft: 24 }}>
            <textarea value={mcbMsg} onChange={e => setMcbMsg(e.target.value)} rows={2} maxLength={320}
              style={{ flex: 1, maxWidth: 460, padding: '6px 8px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', resize: 'vertical' }} />
            <button className="btn btn-sm btn-secondary" disabled={!mcbMsg.trim()} onClick={() => saveMode({ missed_call_message: mcbMsg })}>Save message</button>
          </div>
        )}
      </div>
    </section>
  )
}
