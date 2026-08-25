import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'

// P2-5: review duplicate contacts (grouped by phone) and merge them safely. Merging
// reassigns all history to the primary and archives the rest — nothing is deleted.
export default function Duplicates() {
  const [groups, setGroups] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState('')
  const load = () => authFetch('/api/clients/duplicates').then(r => r.json()).then(d => setGroups(d.groups || [])).catch(() => setGroups([]))
  useEffect(() => { load() }, [])

  const merge = async (group, primaryId) => {
    const dupIds = group.members.map(m => m.id).filter(id => id !== primaryId)
    if (!dupIds.length) return
    if (!confirm(`Merge ${dupIds.length} duplicate${dupIds.length === 1 ? '' : 's'} into "${group.members.find(m => m.id === primaryId).first_name} ${group.members.find(m => m.id === primaryId).last_name}"?\n\nAll calls, texts, notes, tasks and history move to the primary. The others are archived (not deleted).`)) return
    setBusy(group.key); setMsg('')
    try {
      const r = await authFetch('/api/clients/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ primary_id: primaryId, duplicate_ids: dupIds }) })
      const d = await r.json()
      if (d.success) { setMsg(`Merged ${d.count} into #${primaryId}.`); load() }
      else setMsg('Merge failed: ' + (d.error || 'unknown'))
    } catch (e) { setMsg('Merge failed: ' + e.message) } finally { setBusy(null) }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Duplicate Contacts</h1><p className="page-subtitle">Same phone number across multiple records. Merge keeps all history on the primary and archives the rest — nothing is deleted.</p></div>
      </div>
      {msg && <div className="detail-section" style={{ marginBottom: 12, color: msg.includes('failed') ? '#ef4444' : '#10b981' }}>{msg}</div>}
      {groups === null ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
        : groups.length === 0 ? (
          <div className="detail-section" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 34 }}>✓</div><div style={{ marginTop: 8, fontWeight: 600, color: 'var(--text-primary)' }}>No phone-number duplicates found</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {groups.map(g => (
              <div key={g.key} className="detail-section">
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Phone ···{String(g.key).slice(-4)} · {g.count} records</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.members.map(m => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{`${m.first_name || ''} ${m.last_name || ''}`.trim() || m.phone} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>#{m.id}</span></div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[m.address, m.city, m.email].filter(Boolean).join(' · ') || '—'} · {m.status} · {m.comms} comms{m.sierra_lead_id ? ' · Sierra ' + m.sierra_lead_id : ''}</div>
                      </div>
                      <button className="btn btn-sm btn-primary" disabled={busy === g.key} onClick={() => merge(g, m.id)}>{busy === g.key ? '…' : 'Keep this, merge others →'}</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
