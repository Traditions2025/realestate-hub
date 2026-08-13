import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'

const GROUP_META = {
  high: { label: 'High Match', color: '#16a34a', bg: 'rgba(22,163,74,.12)' },
  possible: { label: 'Possible', color: '#d97706', bg: 'rgba(217,119,6,.12)' },
  low: { label: 'Low', color: '#6b7280', bg: 'rgba(107,114,128,.12)' },
}

export default function CampaignMatch() {
  const [campaigns, setCampaigns] = useState([])
  const [key, setKey] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [result, setResult] = useState(null)
  const [filter, setFilter] = useState('all')
  const [sel, setSel] = useState(() => new Set())
  const [enrolledIds, setEnrolledIds] = useState(() => new Set())
  const [showNotRec, setShowNotRec] = useState(false)
  // enroll flow
  const [drips, setDrips] = useState([])
  const [targetDrip, setTargetDrip] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [preflight, setPreflight] = useState(null)
  const [enrolling, setEnrolling] = useState(false)

  useEffect(() => {
    authFetch('/api/campaign-match/campaigns').then(r => r.json()).then(cs => { setCampaigns(cs); if (cs[0]) setKey(cs[0].key) })
    authFetch('/api/drips').then(r => r.json()).then(d => setDrips(Array.isArray(d) ? d : []))
  }, [])

  const campaign = campaigns.find(c => c.key === key)

  const analyze = async () => {
    setAnalyzing(true); setResult(null); setSel(new Set()); setEnrolledIds(new Set()); setFilter('all')
    try {
      const r = await authFetch(`/api/campaign-match/${key}/analyze`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Analyze failed')
      setResult(j)
      setTargetDrip(j.campaign.dripId || '')
    } catch (e) { alert('Analyze failed: ' + e.message) }
    setAnalyzing(false)
  }

  const shown = result ? result.candidates.filter(c => filter === 'all' || c.group === filter).filter(c => !enrolledIds.has(c.id)) : []
  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectShown = () => setSel(s => { const n = new Set(s); shown.forEach(c => n.add(c.id)); return n })
  const selectHigh = () => setSel(s => { const n = new Set(s); result.candidates.filter(c => c.group === 'high' && !enrolledIds.has(c.id)).forEach(c => n.add(c.id)); return n })
  const clearSel = () => setSel(new Set())

  const openEnroll = async () => {
    const ids = [...sel]
    if (!ids.length) return
    try {
      const r = await authFetch(`/api/campaign-match/${key}/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
      setPreflight(await r.json())
    } catch { setPreflight({ total: ids.length, warnings: [] }) }
    setConfirmOpen(true)
  }

  const doEnroll = async () => {
    setEnrolling(true)
    const dripId = campaign?.dripId || Number(targetDrip)
    const items = result.candidates.filter(c => sel.has(c.id)).map(c => ({ id: c.id, match: c.match, why: c.why }))
    try {
      const r = await authFetch(`/api/campaign-match/${key}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, drip_id: dripId }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Enroll failed')
      setEnrolledIds(s => { const n = new Set(s); items.forEach(i => n.add(i.id)); return n })
      setSel(new Set()); setConfirmOpen(false)
      alert(`Enrolled ${j.enrolled} contact${j.enrolled === 1 ? '' : 's'} into the campaign.${j.skipped ? ` (${j.skipped} skipped — already enrolled)` : ''}`)
    } catch (e) { alert('Enroll failed: ' + e.message) }
    setEnrolling(false)
  }

  const c = result?.counts

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>AI Campaign Match</h1>
          <p className="page-subtitle">Let the Hub read the full database and recommend who fits a campaign, with the reason why.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 280px' }}>Campaign
            <select value={key} onChange={e => { setKey(e.target.value); setResult(null); setSel(new Set()) }}>
              {campaigns.map(cp => <option key={cp.key} value={cp.key}>{cp.label}{cp.hasDrip ? '' : ' (no drip yet)'}</option>)}
            </select>
          </label>
          <button className="btn btn-primary" onClick={analyze} disabled={analyzing || !key}>
            {analyzing ? 'Analyzing database…' : '◎ Analyze Database'}
          </button>
        </div>
        {analyzing && <div className="card-body" style={{ paddingTop: 0, fontSize: 13, color: 'var(--text-muted)' }}>Reading the full lead history against this campaign's profile. This takes a moment while the AI scores the top candidates…</div>}
      </div>

      {result && (
        <>
          {/* count band */}
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card stat-green"><div className="stat-number">{c.high}</div><div className="stat-label">High Match</div></div>
            <div className="stat-card stat-amber"><div className="stat-number">{c.possible}</div><div className="stat-label">Possible</div></div>
            <div className="stat-card stat-purple"><div className="stat-number">{c.low}</div><div className="stat-label">Low</div></div>
            <div className="stat-card stat-blue"><div className="stat-number">{c.total_eligible}</div><div className="stat-label">Total Eligible</div></div>
            <div className="stat-card stat-rose"><div className="stat-number">{c.not_recommended}</div><div className="stat-label">Not Recommended</div></div>
          </div>
          {!result.campaign.ai && <p className="muted" style={{ fontSize: 12, marginTop: -8 }}>Note: AI scoring is not configured on the server, so these are ranked by the deterministic signal score only.</p>}

          {/* toolbar */}
          <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="view-toggle">
              {['all', 'high', 'possible', 'low'].map(g => (
                <button key={g} className={filter === g ? 'active' : ''} onClick={() => setFilter(g)}>{g === 'all' ? 'All' : GROUP_META[g].label}</button>
              ))}
            </div>
            <button className="btn btn-sm btn-secondary" onClick={selectHigh}>Select all High</button>
            <button className="btn btn-sm btn-secondary" onClick={selectShown}>Select shown</button>
            <button className="btn btn-sm btn-secondary" onClick={clearSel} disabled={!sel.size}>Clear</button>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{sel.size} selected</span>
              <button className="btn btn-primary" disabled={!sel.size} onClick={openEnroll}>Enroll Selected ({sel.size})</button>
            </div>
          </div>

          {/* table */}
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th style={{ width: 34 }}></th><th>Contact</th><th style={{ width: 90 }}>Match</th><th style={{ width: 90 }}>Intent</th><th>Why the Hub recommends them</th></tr></thead>
              <tbody>
                {shown.length === 0 ? <tr><td colSpan="5" className="empty-state">No contacts in this group.</td></tr> : shown.map(row => {
                  const g = GROUP_META[row.group] || GROUP_META.low
                  return (
                    <tr key={row.id}>
                      <td><input type="checkbox" checked={sel.has(row.id)} onChange={() => toggle(row.id)} /></td>
                      <td><div style={{ fontWeight: 600 }}>{row.name}</div><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.city || ''}{row.city && row.type ? ' · ' : ''}{row.type || ''}</div></td>
                      <td><span style={{ fontWeight: 700, color: g.color, background: g.bg, borderRadius: 12, padding: '2px 9px', fontSize: 13 }}>{row.match}%</span></td>
                      <td>{row.intent ? <span style={{ fontSize: 12 }}>{row.intent}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      <td style={{ fontSize: 13 }}>{row.why}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* not recommended */}
          {result.not_recommended.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header" style={{ cursor: 'pointer' }} onClick={() => setShowNotRec(v => !v)}>
                <h3>Not Recommended ({result.counts.not_recommended}) {showNotRec ? '▾' : '▸'}</h3>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Would-be candidates the Hub is holding back — and why</span>
              </div>
              {showNotRec && (
                <div className="card-body">
                  {result.not_recommended.map(n => (
                    <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{n.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{n.city || ''}</span></span>
                      <span style={{ color: 'var(--text-muted)' }}>{n.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* enroll confirm */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Enroll into campaign">
        <p>You're about to enroll <strong>{sel.size}</strong> contact{sel.size === 1 ? '' : 's'} into <strong>{campaign?.label}</strong>.</p>
        {campaign && !campaign.dripId && (
          <label>Target drip campaign (this campaign has no drip of its own yet)
            <select value={targetDrip} onChange={e => setTargetDrip(e.target.value)}>
              <option value="">Select a drip…</option>
              {drips.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        {preflight?.warnings?.length > 0 && (
          <div style={{ margin: '10px 0', padding: 10, borderRadius: 8, background: 'rgba(217,119,6,.1)', border: '1px solid rgba(217,119,6,.3)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Quality check</div>
            {preflight.warnings.map((w, i) => <div key={i} style={{ fontSize: 13 }}>• {w.text}</div>)}
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>They'll still be enrolled — this is just a heads-up.</div>
          </div>
        )}
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={() => setConfirmOpen(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={enrolling || (campaign && !campaign.dripId && !targetDrip)} onClick={doEnroll}>{enrolling ? 'Enrolling…' : `Enroll ${sel.size}`}</button>
        </div>
      </Modal>
    </div>
  )
}
