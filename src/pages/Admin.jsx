import React, { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../api'

// Admin command center: everything an owner/admin sets up — users & access, roles &
// permissions, the team directory, connected email inboxes, and the system audit log.
const TABS = [
  ['users', '👥 Users & Access'],
  ['roles', '🛡 Roles & Permissions'],
  ['team', '📇 Team Directory'],
  ['email', '✉ Email Inboxes'],
  ['audit', '📜 Audit Log'],
]
const ROLE_LABEL = {
  owner: 'Owner', admin: 'Admin', agent: 'Agent',
  transaction_coordinator: 'Transaction Coordinator', isa: 'ISA', marketing: 'Marketing', read_only: 'Read Only',
}
const fld = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }

export default function Admin() {
  const [tab, setTab] = useState('users')
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Admin</h1>
        <p className="page-subtitle">Users, roles, team, email, and the system audit log.</p>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 16px' }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-secondary'}`}>{label}</button>
        ))}
      </div>
      {tab === 'users' && <UsersAdmin />}
      {tab === 'roles' && <RolesPanel />}
      {tab === 'team' && <TeamPanel />}
      {tab === 'email' && <EmailPanel />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  )
}

// ---------------- Users & Access ----------------
function UsersAdmin() {
  const [users, setUsers] = useState([])
  const [roles, setRoles] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: 'agent', password: '' })
  const load = useCallback(() => {
    authFetch('/api/users').then(r => r.json()).then(d => Array.isArray(d) ? setUsers(d) : setErr(d.error || 'Not permitted')).catch(() => setErr('Failed to load users'))
    authFetch('/api/users/roles').then(r => r.json()).then(d => setRoles(d.roles || [])).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const add = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const r = await authFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const d = await r.json()
      if (d.error) setErr(d.error)
      else { setForm({ name: '', email: '', phone: '', role: 'agent', password: '' }); load() }
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const patch = async (id, body) => { await authFetch(`/api/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).then(d => { if (d.error) alert(d.error) }); load() }
  const resetPw = async (u) => {
    const pw = window.prompt(`Set a new password for ${u.email} (min 8 characters):`)
    if (!pw) return
    const d = await authFetch(`/api/users/${u.id}/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) }).then(r => r.json())
    if (d.error) alert(d.error); else { alert('Password updated. Existing sessions for this user were signed out.'); load() }
  }
  const revoke = async (u) => { if (!confirm(`Sign ${u.email} out of all devices?`)) return; await authFetch(`/api/users/${u.id}/revoke-sessions`, { method: 'POST' }); alert('All sessions revoked.') }
  const [editing, setEditing] = useState(null)   // { id, name, email }
  const saveEdit = async () => {
    const body = { name: (editing.name || '').trim(), email: (editing.email || '').trim() }
    if (!body.name || !body.email) { alert('Name and email are required.'); return }
    const d = await authFetch(`/api/users/${editing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
    if (d.error) { alert(d.error); return }
    setEditing(null); load()
  }

  const roleOpts = roles.length ? roles : Object.keys(ROLE_LABEL)
  return (
    <div>
      {err && <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', color: '#ef4444', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {/* Add user */}
      <div className="detail-section" style={{ marginBottom: 18 }}>
        <h4>Add a user</h4>
        <form onSubmit={add} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, alignItems: 'end' }}>
          <label style={{ fontSize: 12 }}>Name<input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={fld} /></label>
          <label style={{ fontSize: 12 }}>Email<input required type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={fld} /></label>
          <label style={{ fontSize: 12 }}>Phone<input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={fld} /></label>
          <label style={{ fontSize: 12 }}>Role<select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} style={fld}>{roleOpts.map(r => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}</select></label>
          <label style={{ fontSize: 12 }}>Password (optional)<input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="min 8 chars, or leave blank to invite" style={fld} /></label>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : '+ Add user'}</button>
        </form>
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>Leave the password blank to create an “invited” account, then set a password later. Passwords are stored hashed (scrypt) — never in plain text.</p>
      </div>

      {/* User list */}
      <div className="detail-section">
        <h4>Users ({users.length})</h4>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <th style={{ padding: '6px 8px' }}>Name</th><th style={{ padding: '6px 8px' }}>Email</th><th style={{ padding: '6px 8px' }}>Role</th><th style={{ padding: '6px 8px' }}>Status</th><th style={{ padding: '6px 8px' }}>Last login</th><th style={{ padding: '6px 8px' }}>Actions</th>
            </tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '7px 8px', fontWeight: 600 }}>
                    {editing?.id === u.id
                      ? <input value={editing.name} onChange={e => setEditing(s => ({ ...s, name: e.target.value }))} style={{ ...fld, padding: '4px 6px' }} />
                      : <>{u.name}{u.two_factor_enabled ? <span title="2FA on" style={{ marginLeft: 6, fontSize: 11 }}>🔐</span> : null}</>}
                  </td>
                  <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>
                    {editing?.id === u.id
                      ? <input type="email" value={editing.email} onChange={e => setEditing(s => ({ ...s, email: e.target.value }))} style={{ ...fld, padding: '4px 6px' }} />
                      : u.email}
                  </td>
                  <td style={{ padding: '7px 8px' }}>
                    <select value={u.role} onChange={e => patch(u.id, { role: e.target.value })} style={{ ...fld, width: 'auto', fontSize: 12, padding: '4px 6px' }}>
                      {roleOpts.map(r => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '7px 8px' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: u.status === 'active' ? 'rgba(16,185,129,.12)' : u.status === 'invited' ? 'rgba(245,158,11,.14)' : 'rgba(239,68,68,.12)', color: u.status === 'active' ? '#10b981' : u.status === 'invited' ? '#b45309' : '#ef4444' }}>{u.status}</span>
                  </td>
                  <td style={{ padding: '7px 8px', color: 'var(--text-muted)', fontSize: 12 }}>{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : '—'}</td>
                  <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                    {editing?.id === u.id ? (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>{' '}
                        <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-sm" onClick={() => setEditing({ id: u.id, name: u.name, email: u.email })} title="Edit name & email">✎ Edit</button>{' '}
                        <button className="btn btn-sm" onClick={() => resetPw(u)} title="Set / reset password">🔑 Password</button>{' '}
                        {u.status === 'active'
                          ? <button className="btn btn-sm" onClick={() => patch(u.id, { status: 'disabled' })} title="Disable login">Disable</button>
                          : <button className="btn btn-sm" onClick={() => patch(u.id, { status: 'active' })} title="Enable login">Enable</button>}{' '}
                        <button className="btn btn-sm" onClick={() => revoke(u)} title="Sign out everywhere">Revoke</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && !err && <tr><td colSpan={6} style={{ padding: 12, color: 'var(--text-muted)' }}>No users yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------- Roles & Permissions ----------------
function RolesPanel() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => { authFetch('/api/users/roles').then(r => r.json()).then(d => d.error ? setErr(d.error) : setData(d)).catch(() => setErr('Failed to load')) }, [])
  if (err) return <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>
  if (!data) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
  return (
    <div className="detail-section">
      <h4>What each role can do</h4>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Owner has full control. Permissions are enforced server-side; route-by-route enforcement is rolling out.</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr>
            <th style={{ padding: '6px 8px', textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg-primary)' }}>Permission</th>
            {data.roles.map(r => <th key={r} style={{ padding: '6px 8px', writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: 'var(--navy, var(--text-primary))', fontWeight: 700 }}>{ROLE_LABEL[r] || r}</th>)}
          </tr></thead>
          <tbody>
            {data.permissions.map(p => (
              <tr key={p} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '5px 8px', fontFamily: 'monospace', position: 'sticky', left: 0, background: 'var(--bg-primary)' }}>{p}</td>
                {data.roles.map(r => (
                  <td key={r} style={{ padding: '5px 8px', textAlign: 'center', color: data.matrix[r]?.includes(p) ? '#10b981' : 'var(--border)' }}>{data.matrix[r]?.includes(p) ? '●' : '·'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- Team Directory (team_agents) ----------------
function TeamPanel() {
  const [agents, setAgents] = useState([])
  const [form, setForm] = useState({ name: '', phone: '', title: '' })
  const load = useCallback(() => authFetch('/api/agents').then(r => r.json()).then(d => setAgents(Array.isArray(d) ? d : [])).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const add = async (e) => { e.preventDefault(); if (!form.name.trim()) return; await authFetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); setForm({ name: '', phone: '', title: '' }); load() }
  const remove = async (id) => { if (!confirm('Remove this teammate from the directory?')) return; await authFetch(`/api/agents/${id}`, { method: 'DELETE' }); load() }
  return (
    <div className="detail-section">
      <h4>Team directory</h4>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Teammates you can loop into a client text and assign conversations to. (This is the contact directory — login accounts are under “Users & Access”.)</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {agents.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
            <span style={{ fontWeight: 600 }}>{a.name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{a.phone || '—'}</span>
            {a.title && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {a.title}</span>}
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => remove(a.id)}>Remove</button>
          </div>
        ))}
        {agents.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No teammates yet.</div>}
      </div>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Name" style={{ ...fld, width: 'auto', flex: '1 1 150px' }} />
        <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="Phone" style={{ ...fld, width: 'auto', flex: '1 1 130px' }} />
        <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Title (optional)" style={{ ...fld, width: 'auto', flex: '1 1 130px' }} />
        <button className="btn btn-primary">+ Add teammate</button>
      </form>
    </div>
  )
}

// ---------------- Email Inboxes (Gmail IMAP via app passwords) ----------------
function EmailPanel() {
  const [boxes, setBoxes] = useState([])
  const [form, setForm] = useState({ user: '', app_password: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = useCallback(() => authFetch('/api/settings/mailboxes').then(r => r.json()).then(d => setBoxes(Array.isArray(d) ? d : [])).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const add = async (e) => {
    e.preventDefault(); setBusy(true); setMsg('')
    try {
      const r = await authFetch('/api/settings/mailboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const d = await r.json()
      if (d.error) setMsg('⚠ ' + d.error)
      else { setMsg(d.connected ? '✓ Connected' : ('⚠ Could not connect: ' + (d.last_error || 'check the app password'))); setForm({ user: '', app_password: '' }); load() }
    } catch (e) { setMsg('⚠ ' + e.message) } finally { setBusy(false) }
  }
  const test = async (id) => { const d = await authFetch(`/api/settings/mailboxes/${id}/test`, { method: 'POST' }).then(r => r.json()); alert(d.connected ? 'Connected ✓' : 'Not connected: ' + (d.last_error || 'unknown')); load() }
  const remove = async (id) => { if (!confirm('Disconnect this inbox?')) return; await authFetch(`/api/settings/mailboxes/${id}`, { method: 'DELETE' }); load() }
  return (
    <div className="detail-section">
      <h4>Connected email inboxes</h4>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Connect a Gmail account with an <b>App Password</b> (Google Account → Security → 2-Step Verification → App passwords). The Hub reads client replies from these inboxes and can pull full email history.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {boxes.map(b => (
          <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
            <span style={{ fontWeight: 600 }}>{b.user}</span>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: b.connected ? 'rgba(16,185,129,.12)' : 'rgba(239,68,68,.12)', color: b.connected ? '#10b981' : '#ef4444' }}>{b.connected ? 'connected' : 'not connected'}</span>
            {b.last_error && <span style={{ fontSize: 11, color: '#b45309' }}>{b.last_error}</span>}
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => test(b.id)}>Test</button>
            <button className="btn btn-sm" onClick={() => remove(b.id)}>Disconnect</button>
          </div>
        ))}
        {boxes.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No inboxes connected yet.</div>}
      </div>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="email" value={form.user} onChange={e => setForm(f => ({ ...f, user: e.target.value }))} placeholder="you@gmail.com" style={{ ...fld, width: 'auto', flex: '1 1 200px' }} />
        <input type="password" value={form.app_password} onChange={e => setForm(f => ({ ...f, app_password: e.target.value }))} placeholder="16-char app password" style={{ ...fld, width: 'auto', flex: '1 1 200px' }} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Connecting…' : '+ Connect inbox'}</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('✓') ? '#10b981' : '#b45309' }}>{msg}</span>}
      </form>
    </div>
  )
}

// ---------------- Audit Log ----------------
function AuditPanel() {
  const [rows, setRows] = useState([])
  const [err, setErr] = useState('')
  useEffect(() => { authFetch('/api/users/audit?limit=200').then(r => r.json()).then(d => Array.isArray(d) ? setRows(d) : setErr(d.error || 'Not permitted')).catch(() => setErr('Failed to load')) }, [])
  if (err) return <div className="detail-section"><h4>Audit log</h4><div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div></div>
  return (
    <div className="detail-section">
      <h4>System audit log</h4>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Logins, user/role changes, password resets, and permission checks. Newest first.</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase' }}>
            <th style={{ padding: '5px 8px' }}>When</th><th style={{ padding: '5px 8px' }}>Action</th><th style={{ padding: '5px 8px' }}>Actor</th><th style={{ padding: '5px 8px' }}>Target</th><th style={{ padding: '5px 8px' }}>IP</th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '5px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.created_at ? new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString() : ''}</td>
                <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>{r.action}</td>
                <td style={{ padding: '5px 8px' }}>{r.actor || '—'}</td>
                <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{r.entity_type ? `${r.entity_type}${r.entity_id ? ' #' + r.entity_id : ''}` : '—'}</td>
                <td style={{ padding: '5px 8px', color: 'var(--text-muted)', fontSize: 11 }}>{r.ip_address || ''}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} style={{ padding: 12, color: 'var(--text-muted)' }}>No audit entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
