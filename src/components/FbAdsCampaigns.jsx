// Marketing > Facebook Ads: live campaign tracking pulled from the Meta Graph API
// (server/fb-ads.js syncs every 6h; Refresh pulls now). Shows status, start date,
// daily budget, spend, impressions, reach, clicks, CTR, leads, CPL, video views
// and a last-7-days snapshot. When the access token expires, a renewal banner
// with a paste box appears instead of silently stale numbers.
import React, { useState, useEffect } from 'react'
import { api } from '../api'

const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString())
const fmt$ = (n) => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }))
const fmtD = (s) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const STATUS_COLOR = { ACTIVE: 'var(--success, #16a34a)', PAUSED: '#b45309', ARCHIVED: 'var(--text-secondary)', CAMPAIGN_PAUSED: '#b45309', WITH_ISSUES: '#dc2626' }

export default function FbAdsCampaigns() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => api.getFbAds().then(setData).catch(() => setData({ error: true }))
  useEffect(() => { load() }, [])

  const refresh = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await api.syncFbAds()
      setMsg(r.ok ? `Refreshed ${r.campaigns} campaign(s) from Facebook` : (r.error || r.skipped || 'refresh failed'))
    } catch (e) { setMsg(e.message) }
    setBusy(false); load()
  }

  const saveToken = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await api.saveFbAdsToken(tokenInput.trim())
      if (r.ok) { setMsg(`Token saved (connected as ${r.as}). Pulling fresh numbers…`); setTokenInput(''); setTimeout(load, 8000) }
      else setMsg(r.error || 'token rejected')
    } catch (e) { setMsg(e.message) }
    setBusy(false); load()
  }

  if (!data) return <div className="empty-state-full">Loading Facebook Ads…</div>
  const needsToken = !data.token_present || data.token_error
  const t = data.totals || {}

  return (
    <div>
      {needsToken && (
        <div style={{ border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.08)', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Facebook access token {data.token_error ? 'expired' : 'needed'}</div>
          {data.token_error && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 6 }}>{data.token_error}</div>}
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>
            Generate one in <b>Graph API Explorer</b> (app: Matt Smith Team Reporting, permission ads_read), extend it in the Access Token Debugger, then paste it here.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="form-input" style={{ flex: 1, minWidth: 220 }} placeholder="Paste new access token" value={tokenInput} onChange={e => setTokenInput(e.target.value)} />
            <button className="btn btn-primary" disabled={busy || tokenInput.trim().length < 40} onClick={saveToken}>Save token</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Account {data.account_id} · Last synced {data.last_sync ? new Date(data.last_sync).toLocaleString() : 'never'} · auto-refreshes every 6h
        </div>
        <button className="btn btn-secondary" disabled={busy} onClick={refresh}>{busy ? 'Refreshing…' : '↻ Refresh from Facebook'}</button>
        {msg && <span style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>

      <div className="stats-grid stats-small">
        <div className="stat-card stat-green"><div className="stat-number">{fmt$(t.active_spend)}</div><div className="stat-label">Ad Spend (Running Campaigns)</div></div>
        <div className="stat-card stat-purple"><div className="stat-number">{fmtN(data.last30?.leads)}</div><div className="stat-label">Leads (Last 30 Days)</div></div>
        <div className="stat-card stat-blue"><div className="stat-number">{fmtN(data.last30?.impressions)}</div><div className="stat-label">Impressions (Last 30 Days)</div></div>
        <div className="stat-card stat-orange"><div className="stat-number">{fmtN(data.last30?.reach)}</div><div className="stat-label">Reach (Last 30 Days)</div></div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <th>Campaign</th><th>Status</th><th>Start</th><th>Daily Budget</th><th>Spend</th>
            <th>Impressions</th><th>Reach</th><th>Clicks</th><th>CTR</th><th>Leads</th><th>CPL</th><th>Video Views</th><th>Last 7 Days</th>
          </tr></thead>
          <tbody>
            {(data.campaigns || []).length === 0 && (
              <tr><td colSpan="13" className="empty-state">{needsToken ? 'Connect a token above to pull your campaigns.' : 'No campaigns synced yet — hit Refresh.'}</td></tr>
            )}
            {(data.campaigns || []).map(c => (
              <tr key={c.campaign_id}>
                <td style={{ fontWeight: 600, maxWidth: 240 }}>{c.name}<div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 400 }}>{c.objective}</div></td>
                <td><span style={{ color: STATUS_COLOR[c.effective_status] || 'var(--text-secondary)', fontWeight: 700, fontSize: 12 }}>{c.effective_status}</span></td>
                <td>{fmtD(c.start_time)}</td>
                <td>{fmt$(c.daily_budget)}</td>
                <td>{fmt$(c.spend)}</td>
                <td>{fmtN(c.impressions)}</td>
                <td>{fmtN(c.reach)}</td>
                <td>{fmtN(c.clicks)}</td>
                <td>{c.ctr ? Number(c.ctr).toFixed(2) + '%' : '—'}</td>
                <td style={{ fontWeight: 700 }}>{fmtN(c.leads)}</td>
                <td>{fmt$(c.cost_per_lead)}</td>
                <td>{fmtN(c.video_views)}</td>
                <td style={{ fontSize: 12 }}>{c.last7 ? `${fmtN(c.last7.leads)} leads · ${fmt$(c.last7.spend)} · ${fmtN(c.last7.impressions)} impr` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
