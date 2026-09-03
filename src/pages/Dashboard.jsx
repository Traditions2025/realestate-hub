import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api, authFetch } from '../api'

// ============================================================================
// DASHBOARD — the daily operating command center. Answers, within seconds:
// what needs attention, who to contact, what's happening today, what's coming,
// what's heating up, is AI waiting on me, are transactions + the Hub healthy.
// Deep analysis lives in Reporting; every number here clicks through to the
// underlying records (Inbox, Clients smart lists, AI Opportunities, Tasks, …).
// ============================================================================

const DASHBOARD_CACHE_KEY = 'mst_dashboard_cache'

const timeAgo = (iso) => {
  if (!iso) return ''
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (isNaN(m)) return ''
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
const fmtMoney = (n) => n ? `$${Number(n).toLocaleString()}` : '$0'
const fmtTime = (t) => {
  if (!t) return ''
  const [h, mm] = String(t).split(':').map(Number)
  if (isNaN(h)) return t
  const ap = h >= 12 ? 'PM' : 'AM'
  return `${((h + 11) % 12) + 1}:${String(mm || 0).padStart(2, '0')} ${ap}`
}
const fmtDay = (ymd) => {
  if (!ymd) return ''
  const d = new Date(ymd + 'T12:00:00')
  return isNaN(d) ? ymd : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Section shell: consistent title + optional "View →" link, compact body.
function Section({ title, link, linkLabel, children, accent }) {
  return (
    <div className="card" style={{ padding: '14px 16px', borderTop: accent ? `3px solid ${accent}` : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{title}</h3>
        {link && <Link to={link} style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600 }}>{linkLabel || 'View →'}</Link>}
      </div>
      {children}
    </div>
  )
}
const Empty = ({ children }) => <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>{children}</div>

// A clickable count chip (pipeline / prospecting rows).
function Chip({ to, label, value, tone }) {
  const colors = { red: '#ef4444', amber: '#d97706', green: '#059669', purple: '#7c3aed', blue: '#2563eb' }
  const inner = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 12.5, cursor: to ? 'pointer' : 'default' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <strong style={{ color: tone ? colors[tone] : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{Number(value || 0).toLocaleString()}</strong>
    </span>
  )
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{inner}</Link> : inner
}

const ATTN_META = {
  handoff: { badge: '🤖 AI HANDOFF', color: '#ef4444' },
  need_response: { badge: '💬 NEEDS REPLY', color: '#d97706' },
  missed_call: { badge: '📞 MISSED CALL', color: '#ef4444' },
}

export default function Dashboard() {
  const [data, setData] = useState(() => { try { const raw = localStorage.getItem(DASHBOARD_CACHE_KEY); return raw ? JSON.parse(raw) : null } catch { return null } })
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [me, setMe] = useState(null)
  useEffect(() => { authFetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {}) }, [])
  // Who to greet: a per-user account name wins; on the shared team login, fall back to the
  // Inbox "I am …" agent identity (mst_agent) so John sees John and Matt sees Matt.
  const firstName = (me && !me.team && me.name) ? me.name.split(' ')[0] : ((typeof localStorage !== 'undefined' && localStorage.getItem('mst_agent')) || '')

  const load = () => {
    setRefreshing(true)
    api.dashboard().then(d => {
      setData(d); setLoading(false); setRefreshing(false)
      try { localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(d)) } catch {}
    }).catch(() => { setLoading(false); setRefreshing(false) })
  }
  useEffect(() => { load() }, [])
  // Communication/attention data refreshes every 60s; heavier blocks ride along (single endpoint).
  useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t) }, [])

  if (!data && loading) return <div className="page-loading">Loading dashboard...</div>
  if (!data) return <div className="page-loading">Failed to load dashboard</div>

  const cards = data.cards || {}
  const attention = data.attention || []
  const schedule = data.schedule || []
  const pipeline = data.pipeline || {}
  const prospecting = data.prospecting || {}
  const tx = data.tx || {}
  const radar = data.radar || { examples: {} }
  const ai = data.ai || {}
  const comm = data.comm_today || {}
  const health = data.health || { ok: true, issues: [] }
  const business = data.business || null

  // Central-time greeting + date line.
  const ctNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const greeting = ctNow.getHours() < 12 ? 'Good morning' : ctNow.getHours() < 17 ? 'Good afternoon' : 'Good evening'
  const dateLine = ctNow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const row = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 14, marginBottom: 14 }

  // "✓ Done" on an attention card: record the dismissal (item-keyed — new activity resurfaces)
  // and remove it optimistically; counts adjust without waiting for the next refresh.
  const dismissAttention = async (a) => {
    try { await authFetch('/api/dashboard/attention/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: a.type, client_id: a.client_id, ref: a.ref }) }) } catch {}
    setData(d => ({
      ...d,
      attention: (d.attention || []).filter(x => x !== a),
      cards: {
        ...d.cards,
        need_response: a.type === 'need_response' ? Math.max(0, (d.cards?.need_response || 0) - 1) : d.cards?.need_response,
        ai_handoffs: a.type === 'handoff' ? Math.max(0, (d.cards?.ai_handoffs || 0) - 1) : d.cards?.ai_handoffs,
      },
    }))
  }

  const actionCards = [
    { n: cards.priority_leads, label: 'Priority Leads', to: '#attention', cls: 'stat-rose' },
    { n: cards.need_response, label: 'Need Response', to: '/inbox', cls: 'stat-amber' },
    { n: cards.ai_handoffs, label: 'AI Handoffs', to: '/ai-opportunities', cls: 'stat-purple' },
    { n: cards.followups_due, label: 'Follow-Ups Due', to: '/tasks', cls: 'stat-blue' },
    { n: cards.appointments_today, label: 'Appointments Today', to: '/calendar', cls: 'stat-teal' },
    { n: cards.overdue_tasks, label: 'Overdue Tasks', to: '/tasks', cls: 'stat-rose' },
  ]

  return (
    <div className="page">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="page-header" style={{ marginBottom: 10 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{greeting}{firstName ? `, ${firstName}` : ''} {refreshing && <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>· refreshing…</span>}</h1>
          <p className="page-subtitle">{dateLine}</p>
        </div>
      </div>

      {/* ── Row 1: action cards (every card opens its work queue) ── */}
      <div className="stats-grid" style={{ marginBottom: 14 }}>
        {actionCards.map(c => (
          c.to === '#attention'
            ? <a key={c.label} href="#attention" style={{ textDecoration: 'none' }} onClick={e => { e.preventDefault(); document.getElementById('attention')?.scrollIntoView({ behavior: 'smooth' }) }}>
                <div className={`stat-card ${c.cls}`} style={{ cursor: 'pointer' }}><div className="stat-number">{c.n ?? 0}</div><div className="stat-label">{c.label}</div></div>
              </a>
            : <Link key={c.label} to={c.to} style={{ textDecoration: 'none' }}>
                <div className={`stat-card ${c.cls}`} style={{ cursor: 'pointer' }}><div className="stat-number">{c.n ?? 0}</div><div className="stat-label">{c.label}</div></div>
              </Link>
        ))}
      </div>

      {/* ── Row 2: Needs Attention + Today's Schedule ─────────────── */}
      <div style={{ ...row, gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        <div id="attention">
          <Section title="Needs Your Attention" accent="#ef4444">
            {attention.length === 0 ? <Empty>Nothing waiting on you right now. 🎉</Empty> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {attention.map((a, i) => {
                  const meta = ATTN_META[a.type] || { badge: a.type, color: 'var(--text-muted)' }
                  return (
                    <div key={i} style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${meta.color}`, borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13.5 }}>{a.client_id ? <Link to={`/clients/${a.client_id}`} style={{ color: 'inherit' }}>{a.name}</Link> : a.name}</strong>
                        <span style={{ fontSize: 10, fontWeight: 800, color: meta.color, letterSpacing: '.04em' }}>{meta.badge}</span>
                        {a.intent != null && <span style={{ fontSize: 10.5, fontWeight: 700, background: 'rgba(37,99,235,.12)', color: '#2563eb', borderRadius: 10, padding: '1px 7px' }}>Intent {a.intent}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeAgo(a.at)}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>{a.reason}{a.agent ? ` · ${a.agent}` : ''}</div>
                      {a.detail && <div style={{ fontSize: 12.5, marginTop: 3, fontStyle: 'italic' }}>“{a.detail}”</div>}
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        {a.client_id && <Link className="btn btn-sm btn-primary" to={`/inbox?client=${a.client_id}`}>Reply</Link>}
                        {a.client_id && <Link className="btn btn-sm" to={`/clients/${a.client_id}`}>Open</Link>}
                        {a.type === 'handoff' && <Link className="btn btn-sm" to="/ai-opportunities">Handoff queue</Link>}
                        <button className="btn btn-sm" style={{ marginLeft: 'auto', color: '#059669', borderColor: 'rgba(5,150,105,.4)' }}
                          title="Mark as addressed — removes this item (a new reply or call from them will bring them back)"
                          onClick={() => dismissAttention(a)}>✓ Done</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Section>
        </div>
        <Section title="Today's Schedule" link="/calendar" linkLabel="View Calendar →">
          {schedule.length === 0 ? <Empty>No appointments scheduled today.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {schedule.map((e, i) => (
                <Link key={i} to={e.link || '/calendar'} style={{ display: 'flex', gap: 10, alignItems: 'baseline', textDecoration: 'none', color: 'inherit', padding: '4px 2px', borderBottom: i < schedule.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 66, color: '#2563eb', fontVariantNumeric: 'tabular-nums' }}>{fmtTime(e.time) || '—'}</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto', textAlign: 'right' }}>{e.location}</span>
                </Link>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* ── Row 3: Pipeline + Transactions ────────────────────────── */}
      <div style={row}>
        <Section title="Lead Pipeline" link="/clients" linkLabel="Open Clients →">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            <Chip to="/clients?tab=prime" label="Prime" value={pipeline.prime} />
            <Chip to="/clients?tab=active" label="Active" value={pipeline.active} />
            <Chip to="/clients?tab=qualify" label="Qualify" value={pipeline.qualify} />
            <Chip to="/clients?tab=watch" label="Watch" value={pipeline.watch} />
            <Chip to="/clients?tab=pending" label="Pending" value={pipeline.pending} />
            <Chip to="/clients?tab=new" label="New" value={pipeline.new} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Chip to="/clients?sort=highest_score" label="High Intent" value={pipeline.high_intent} tone="red" />
            <Chip to="/inbox" label="Need Response" value={pipeline.need_response} tone="amber" />
            <Chip to="/clients?smart=viewed_24h" label="Viewed 24h" value={pipeline.viewed_24h} tone="green" />
            <Chip to="/clients" label="AI Managed" value={pipeline.ai_managed} tone="purple" />
          </div>
        </Section>
        <Section title="Transactions" link="/transactions" accent="#2563eb">
          <div style={{ display: 'flex', gap: 14, marginBottom: 8 }}>
            <div><div style={{ fontSize: 22, fontWeight: 800 }}>{tx.open ?? 0}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Open / Pending</div></div>
            <div><div style={{ fontSize: 22, fontWeight: 800, color: tx.deadlines_today ? '#d97706' : 'var(--text-primary)' }}>{tx.deadlines_today ?? 0}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Deadlines Today</div></div>
          </div>
          {(tx.closings_7d || []).length === 0 ? <Empty>No closings in the next 7 days.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tx.closings_7d.map((c, i) => (
                <Link key={i} to="/transactions" style={{ display: 'flex', gap: 8, fontSize: 12.5, textDecoration: 'none', color: 'inherit' }}>
                  <strong style={{ minWidth: 52, color: '#2563eb' }}>{fmtDay(c.date)}</strong>
                  <span>Closing · {c.address}</span>
                </Link>
              ))}
            </div>
          )}
          {(tx.deadline_items || []).length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#d97706' }}>
              {tx.deadline_items.map((d, i) => <div key={i}>⚠ {d.label} · {d.address}</div>)}
            </div>
          )}
        </Section>
      </div>

      {/* ── Row 4: Opportunity Radar + HUB AI ─────────────────────── */}
      <div style={row}>
        <Section title="Opportunity Radar" link="/clients?smart=returned_past_client" linkLabel="View Opportunities →" accent="#059669">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            <Chip label="Re-engaged (7d)" value={radar.reengaged} tone="green" />
            <Chip label="Repeat Viewers" value={radar.repeat_viewers} tone="green" />
            <Chip label="Past Clients Active" value={radar.past_clients_active} tone="green" />
          </div>
          {[...(radar.examples?.repeat || []).map(r => ({ ...r, note: `viewed ${r.prop} ×${r.n} this week` })),
            ...(radar.examples?.reengaged || []).map(r => ({ ...r, note: 'back after a long quiet stretch' })),
            ...(radar.examples?.past_clients || []).map(r => ({ ...r, note: 'past client browsing again' }))].slice(0, 5).map((r, i) => (
              <div key={i} style={{ fontSize: 12.5, padding: '2px 0' }}>
                <Link to={`/clients/${r.id}`} style={{ fontWeight: 600 }}>{r.name}</Link>
                <span style={{ color: 'var(--text-secondary)' }}> — {r.note}</span>
              </div>
            ))}
          {!radar.reengaged && !radar.repeat_viewers && !radar.past_clients_active && <Empty>No new heat this week yet.</Empty>}
        </Section>
        <Section title="HUB AI" link="/ai-opportunities" accent="#7c3aed">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            <Chip label="AI-Managed" value={ai.managed} tone="purple" />
            <Chip to="/ai-opportunities" label="Waiting for Human" value={ai.handoffs_open} tone={ai.handoffs_open ? 'red' : 'purple'} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, fontSize: 12.5 }}>
            <div><strong style={{ fontSize: 18 }}>{ai.sent_today ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>AI texts today</div></div>
            <div><strong style={{ fontSize: 18 }}>{ai.responses_today ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Responses</div></div>
            <div><strong style={{ fontSize: 18 }}>{ai.intent_up_today ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Intent increases</div></div>
            <div><strong style={{ fontSize: 18, color: ai.failed_today ? '#ef4444' : 'inherit' }}>{ai.failed_today ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Failed actions</div></div>
          </div>
        </Section>
      </div>

      {/* ── Row 5: Prospecting + Communication Health ─────────────── */}
      <div style={row}>
        <Section title="Prospecting" link="/clients?list=FSBO" linkLabel="Open lists →">
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>FSBO</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <Chip to="/clients?list=FSBO" label="Available" value={prospecting.fsbo_available} />
            <Chip to="/clients?list=FSBO" label="Aging 30+" value={prospecting.fsbo_aging_30} tone="amber" />
            <Chip to="/clients?smart=fsbo_dom14_no_text_2w" label="Follow-Up Due" value={prospecting.fsbo_followup_due} tone="red" />
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>CANCELLED / EXPIRED</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Chip to="/clients?list=Cancelled" label="On List" value={prospecting.cx_total} />
            <Chip to="/clients?smart=cx_no_response" label="No Response Yet" value={prospecting.cx_no_response} tone="amber" />
          </div>
        </Section>
        <Section title="Communication Health" link="/inbox" linkLabel="Open Inbox →">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8, fontSize: 12.5, marginBottom: 8 }}>
            <div><strong style={{ fontSize: 18 }}>{comm.texts_sent ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Texts sent</div></div>
            <div><strong style={{ fontSize: 18 }}>{comm.texts_received ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Texts received</div></div>
            <div><strong style={{ fontSize: 18 }}>{comm.calls ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Calls</div></div>
            <div><strong style={{ fontSize: 18 }}>{comm.emails_sent ?? 0}</strong><div style={{ color: 'var(--text-muted)' }}>Emails sent</div></div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Chip to="/inbox" label="Need Response" value={comm.need_response} tone="amber" />
            <Chip to="/inbox" label="Missed Calls" value={comm.missed_calls} tone={comm.missed_calls ? 'red' : undefined} />
            <Chip to="/inbox" label="Failed Messages" value={comm.failed_messages} tone={comm.failed_messages ? 'red' : undefined} />
          </div>
        </Section>
      </div>

      {/* ── Row 6: Business performance (owner/admin only — backend gated) ── */}
      {business && (
        <div style={{ ...row, gridTemplateColumns: 'minmax(330px, 640px)' }}>
          <Section title="Business Performance" link="/reporting" linkLabel="Reporting →">
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead><tr style={{ color: 'var(--text-muted)', fontSize: 11.5, textAlign: 'right' }}><th style={{ textAlign: 'left', fontWeight: 600 }}></th><th style={{ fontWeight: 700 }}>MTD</th><th style={{ fontWeight: 700 }}>YTD</th></tr></thead>
              <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
                <tr><td style={{ padding: '4px 0' }}>New Leads</td><td style={{ textAlign: 'right' }}>{(business.mtd?.new_leads ?? 0).toLocaleString()}</td><td style={{ textAlign: 'right' }}>{(business.ytd?.new_leads ?? 0).toLocaleString()}</td></tr>
                <tr><td style={{ padding: '4px 0' }}>Closed</td><td style={{ textAlign: 'right' }}>{business.mtd?.closed ?? 0}</td><td style={{ textAlign: 'right' }}>{business.ytd?.closed ?? 0}</td></tr>
                <tr><td style={{ padding: '4px 0' }}>Volume</td><td style={{ textAlign: 'right' }}>{fmtMoney(business.mtd?.volume)}</td><td style={{ textAlign: 'right' }}>{fmtMoney(business.ytd?.volume)}</td></tr>
              </tbody>
            </table>
          </Section>
        </div>
      )}

      {/* ── Row 7: System health ──────────────────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        {health.ok ? (
          <div className="card" style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ color: '#059669', fontWeight: 700 }}>✓ System Healthy</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              Sierra {timeAgo(health.sierra_last) || '—'} · Backup {timeAgo(health.backup_last) || '—'} · FSBO sync {timeAgo(health.fsbo_sync_last) || '—'} · Expired sync {timeAgo(health.expired_sync_last) || '—'}
            </span>
          </div>
        ) : (
          <div className="card" style={{ padding: '10px 16px', borderLeft: '3px solid #ef4444', fontSize: 13 }}>
            <strong style={{ color: '#ef4444' }}>⚠ System issues</strong>
            {health.issues.map((s, i) => <div key={i} style={{ marginTop: 2 }}>⚠ {s}</div>)}
            <Link to="/updates" style={{ fontSize: 12.5 }}>Open diagnostics →</Link>
          </div>
        )}
      </div>

    </div>
  )
}
