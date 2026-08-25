import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom'
import LoginScreen from './components/LoginScreen'
import ResetPassword from './components/ResetPassword'
import CallWidget from './components/CallWidget'
import { authFetch } from './api'

// P2-5: global cross-entity search (clients, transactions, tasks, notes).
const TYPE_ICON = { client: '◉', transaction: '⇄', task: '☑', note: '≡' }
function GlobalSearch() {
  const [q, setQ] = useState('')
  const [res, setRes] = useState(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef(null)
  const navigate = useNavigate()
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return }
    const t = setTimeout(() => {
      authFetch('/api/search?q=' + encodeURIComponent(q.trim())).then(r => r.json())
        .then(d => { setRes(d.results || []); setOpen(true); setActive(0) }).catch(() => setRes([]))
    }, 220)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    const h = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  const go = (r) => { setOpen(false); setQ(''); navigate(r.href) }
  const onKey = (e) => {
    if (!res || !res.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, res.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(res[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }
  return (
    <div ref={boxRef} style={{ position: 'sticky', top: 0, zIndex: 40, padding: '10px 0 6px', background: 'var(--bg-primary, var(--bg))' }}>
      <div style={{ position: 'relative', maxWidth: 560 }}>
        <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => res && setOpen(true)} onKeyDown={onKey}
          placeholder="Search everything — people, transactions, tasks, notes…"
          className="input" style={{ width: '100%', padding: '9px 12px 9px 32px' }} />
        <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-muted)' }}>⌕</span>
        {open && res && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--card, var(--bg-secondary))', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,.18)', maxHeight: 380, overflowY: 'auto' }}>
            {res.length === 0 ? <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>No matches</div>
              : res.map((r, i) => (
                <div key={r.type + r.id} onMouseEnter={() => setActive(i)} onClick={() => go(r)}
                  style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 12px', cursor: 'pointer', background: i === active ? 'var(--bg-secondary)' : 'transparent', borderBottom: '1px solid var(--rule-2, var(--border))' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{TYPE_ICON[r.type] || '•'}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                    {r.subtitle && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subtitle}</div>}
                  </div>
                  <span style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '.04em' }}>{r.type}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

// P2-4/P2-3: notification bell with unread badge, dropdown, and web-push opt-in.
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4)
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64); const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
function NotificationBell() {
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [pushOn, setPushOn] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()
  const poll = () => authFetch('/api/notifications/unread-count').then(r => r.json()).then(d => setUnread(d.unread || 0)).catch(() => {})
  useEffect(() => { poll(); const t = setInterval(poll, 30000); return () => clearInterval(t) }, [])
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => { try { navigator.serviceWorker?.ready.then(reg => reg.pushManager.getSubscription()).then(s => setPushOn(!!s)).catch(() => {}) } catch {} }, [])
  const openList = () => {
    setOpen(o => !o)
    if (!open) authFetch('/api/notifications?limit=30').then(r => r.json()).then(d => { setItems(d.items || []); setUnread(d.unread || 0) }).catch(() => {})
  }
  const go = (n) => { setOpen(false); if (n.id) authFetch(`/api/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {}); if (n.link) navigate(n.link); poll() }
  const markAll = () => { authFetch('/api/notifications/read-all', { method: 'POST' }).then(() => { setUnread(0); setItems(x => x.map(i => ({ ...i, read: 1 }))) }).catch(() => {}) }
  const enablePush = async () => {
    try {
      const perm = await Notification.requestPermission(); if (perm !== 'granted') return
      const reg = await navigator.serviceWorker.ready
      const { key } = await (await authFetch('/api/notifications/vapid-public-key')).json()
      if (!key) { alert('Push is not configured on the server yet.'); return }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) })
      const j = sub.toJSON()
      await authFetch('/api/notifications/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j) })
      setPushOn(true)
    } catch (e) { alert('Could not enable push: ' + e.message) }
  }
  const fmt = (iso) => { try { return new Date(String(iso).includes('Z') ? iso : iso + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return '' } }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="theme-toggle" onClick={openList} title="Notifications" style={{ position: 'relative', padding: '8px 12px' }}>
        <span style={{ fontVariantEmoji: 'text' }}>🔔</span>
        {unread > 0 && <span style={{ position: 'absolute', top: 2, right: 4, background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 10, padding: '0 5px', minWidth: 16, textAlign: 'center' }}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 6, width: 340, maxHeight: 460, overflowY: 'auto', background: 'var(--card, var(--bg-secondary))', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.2)', zIndex: 60 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <strong style={{ fontSize: 13 }}>Notifications</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              {!pushOn && <button className="btn-link" style={{ fontSize: 11.5 }} onClick={enablePush}>Enable push</button>}
              <button className="btn-link" style={{ fontSize: 11.5 }} onClick={markAll}>Mark all read</button>
            </div>
          </div>
          {items.length === 0 ? <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>Nothing yet.</div>
            : items.map(n => (
              <div key={n.id} onClick={() => go(n)} style={{ padding: '9px 12px', borderBottom: '1px solid var(--rule-2, var(--border))', cursor: 'pointer', background: n.read ? 'transparent' : 'var(--bg-secondary)' }}>
                <div style={{ fontSize: 13, fontWeight: n.read ? 500 : 700 }}>{n.title}</div>
                {n.body && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>}
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{fmt(n.created_at)}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

// Lazy load pages so initial bundle is smaller
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Transactions = lazy(() => import('./pages/Transactions'))
const Clients = lazy(() => import('./pages/Clients'))
const Tasks = lazy(() => import('./pages/Tasks'))
const Projects = lazy(() => import('./pages/Projects'))
const Notes = lazy(() => import('./pages/Notes'))
const Marketing = lazy(() => import('./pages/Marketing'))
const Vendors = lazy(() => import('./pages/Vendors'))
const Partners = lazy(() => import('./pages/Partners'))
const SocialMedia = lazy(() => import('./pages/SocialMedia'))
const CampaignMatch = lazy(() => import('./pages/CampaignMatch'))
const SmartAudiences = lazy(() => import('./pages/SmartAudiences'))
const Duplicates = lazy(() => import('./pages/Duplicates'))
const BlogPosts = lazy(() => import('./pages/BlogPosts'))
const Calendar = lazy(() => import('./pages/Calendar'))
const Updates = lazy(() => import('./pages/Updates'))
const Inbox = lazy(() => import('./pages/Inbox'))
const PowerDialer = lazy(() => import('./pages/PowerDialer'))
const AiOpportunities = lazy(() => import('./pages/AiOpportunities'))
const AiSandbox = lazy(() => import('./pages/AiSandbox'))
const Templates = lazy(() => import('./pages/Templates'))
const Settings = lazy(() => import('./pages/Settings'))
const Admin = lazy(() => import('./pages/Admin'))
const Automations = lazy(() => import('./pages/Automations'))
const Reporting = lazy(() => import('./pages/Reporting'))

const navSections = [
  { label: 'MAIN', items: [
    { path: '/', label: 'Dashboard', icon: '\u229E' },
    { path: '/calendar', label: 'Calendar', icon: '\u2630' },
  ]},
  { label: 'PIPELINE', items: [
    // Transactions is the single tab for all listing states (pre-listing \u2192
    // active \u2192 under contract \u2192 closed). Pre-Listings page and Listings tab
    // were retired 2026-07-09 \u2014 everything lives on the Transactions board.
    { path: '/transactions', label: 'Transactions', icon: '\u21C4' },
    { path: '/clients', label: 'Clients', icon: '\u25C9' },
    { path: '/inbox', label: 'Inbox', icon: '\u2709' },
    { path: '/ai-opportunities', label: 'AI Opportunities', icon: '\u2726' },
    { path: '/ai-sandbox', label: 'AI Sandbox', icon: '\u2699' },
  ]},
  { label: 'WORK', items: [
    { path: '/tasks', label: 'Tasks', icon: '\u2610' },
    { path: '/projects', label: 'Projects', icon: '\u25A6' },
    { path: '/notes', label: 'Notes', icon: '\u2261' },
    { path: '/automations', label: 'Automations', icon: '\u26A1' },
  ]},
  { label: 'MARKETING', items: [
    { path: '/marketing', label: 'Campaigns', icon: '\u25C8' },
    { path: '/campaign-match', label: 'AI Campaign Match', icon: '\u25CE' },
    { path: '/smart-audiences', label: 'Smart Audiences', icon: '\u25D1' },
    { path: '/templates', label: 'Templates', icon: '\u2709' },
    { path: '/social-media', label: 'Social Media', icon: '\u2600' },
    { path: '/blog-posts', label: 'Blog Posts', icon: '\u270E' },
  ]},
  { label: 'DIRECTORY', items: [
    { path: '/vendors', label: 'Vendors', icon: '\u2692' },
    { path: '/partners', label: 'Partners', icon: '\u2694' },
  ]},
  { label: 'SYSTEM', items: [
    { path: '/reporting', label: 'Reporting', icon: '\u25a4' },
    { path: '/updates', label: 'Updates', icon: '\u27f3' },
    { path: '/duplicates', label: 'Duplicates', icon: '\u29c9' },
    { path: '/admin', label: 'Admin', icon: '\u26ed' },
    { path: '/settings', label: 'Settings', icon: '\u2699' },
  ]},
]

// Clean "toggle sidebar" panel icon (Lucide panel-left style).
function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  )
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Desktop: collapse (fully hide) the sidebar to give the page full width. Persisted.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('mst_sidebar_collapsed') === '1')
  useEffect(() => { localStorage.setItem('mst_sidebar_collapsed', collapsed ? '1' : '0') }, [collapsed])
  const toggleCollapsed = () => setCollapsed(c => !c)
  // Optimistically authed if we have a token - skip the verify roundtrip on page load
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('mst_token'))

  // Theme: 'dark' (default) or 'light'. Persisted in localStorage. Applied via
  // data-theme attribute on <body> — CSS variables in app.css handle the rest.
  const [theme, setTheme] = useState(() => localStorage.getItem('mst_theme') || 'dark')
  useEffect(() => {
    document.body.setAttribute('data-theme', theme)
    localStorage.setItem('mst_theme', theme)
  }, [theme])
  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  // PWA install: Chrome/Android fire beforeinstallprompt; iOS Safari needs a
  // manual "Add to Home Screen", so we show a short how-to there instead.
  const [installPrompt, setInstallPrompt] = useState(null)
  const [isStandalone, setIsStandalone] = useState(false)
  const [isIos, setIsIos] = useState(false)
  useEffect(() => {
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true)
    setIsIos(/iphone|ipad|ipod/i.test(window.navigator.userAgent) && !window.MSStream)
    const onPrompt = (e) => { e.preventDefault(); setInstallPrompt(e) }
    const onInstalled = () => { setInstallPrompt(null); setIsStandalone(true) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  const installApp = async () => {
    if (installPrompt) { installPrompt.prompt(); try { await installPrompt.userChoice } catch {} setInstallPrompt(null); return }
    if (isIos) alert('Install the Hub on your iPhone or iPad:\n\n1. Tap the Share button in Safari (the square with an up arrow)\n2. Scroll down and tap "Add to Home Screen"\n3. Tap "Add"\n\nIt will appear as an app icon on your home screen.')
  }
  const canInstall = !isStandalone && (!!installPrompt || isIos)

  // Who is signed in (per-user account, or the shared team login).
  const [me, setMe] = useState(null)
  useEffect(() => {
    const token = localStorage.getItem('mst_token')
    if (!token) return
    // Background verify - if it fails, an actual API call will redirect to login
    fetch('/api/auth/verify', { headers: { 'x-auth-token': token } })
      .then(r => { if (!r.ok) { localStorage.removeItem('mst_token'); setAuthed(false) } })
      .catch(() => {})
    fetch('/api/auth/me', { headers: { 'x-auth-token': token } })
      .then(r => r.ok ? r.json() : null).then(d => setMe(d?.user || null)).catch(() => {})
  }, [authed])

  const logout = () => {
    const token = localStorage.getItem('mst_token')
    fetch('/api/auth/logout', { method: 'POST', headers: { 'x-auth-token': token } }).catch(() => {})
    localStorage.removeItem('mst_token'); setMe(null); setAuthed(false)
  }

  // Close sidebar on navigation (mobile)
  const closeSidebar = () => {
    if (window.innerWidth <= 768) setSidebarOpen(false)
  }

  // Public reset-password page (reached from the emailed link), before the auth gate.
  if (typeof window !== 'undefined' && window.location.pathname === '/reset-password') return <ResetPassword />
  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />

  return (
    <div className="app-layout">
      <CallWidget />
      {/* Mobile top bar */}
      <div className="mobile-topbar">
        <button className="hamburger" onClick={() => setSidebarOpen(!sidebarOpen)}>
          {sidebarOpen ? '\u2715' : '\u2630'}
        </button>
        <img src="/logo.png" alt="Matt Smith Team" className="mobile-logo" />
        <div style={{width: 40}}></div>
      </div>

      {/* Overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)}></div>}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <img src="/logo.png" alt="Matt Smith Team" className="logo-img" />
          </div>
          <button className="sidebar-toggle desktop-only" onClick={toggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <PanelIcon />
          </button>
        </div>
        <nav className="sidebar-nav">
          {navSections.map(section => (
            <div key={section.label} className="nav-section">
              <div className="nav-section-label">{section.label}</div>
              {section.items.map(item => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  title={item.label}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  onClick={closeSidebar}
                >
                  <span className="nav-icon" style={{ fontVariantEmoji: 'text' }}>{item.icon + String.fromCharCode(0xFE0E)}</span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          {canInstall && (
            <button className="theme-toggle" onClick={installApp} title="Install the Hub as an app on your device" style={{ marginBottom: 8 }}>
              <span style={{ fontVariantEmoji: 'text' }}>⤓ Install App</span>
            </button>
          )}
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
          >
            <span style={{ fontVariantEmoji: 'text' }}>{theme === 'dark' ? '☼ Light Mode' : '☾ Dark Mode'}</span>
          </button>
          <button className="theme-toggle" onClick={logout} title="Log out and return to the sign-in screen">
            <span style={{ fontVariantEmoji: 'text' }}>⎋ Log Out</span>
          </button>
          {me && !me.team && <div className="team-sub" style={{ marginTop: 6 }}>Signed in as {me.name}</div>}
          <div className="team-sub">RE/MAX Concepts &middot; Cedar Rapids IA</div>
        </div>
      </aside>

      <main className="main-content">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', position: 'sticky', top: 0, zIndex: 40, background: 'var(--bg-primary, var(--bg))' }}>
          <div style={{ flex: 1 }}><GlobalSearch /></div>
          <NotificationBell />
        </div>
        <Suspense fallback={<div className="page-loading">Loading...</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/ai-opportunities" element={<AiOpportunities />} />
            <Route path="/ai-sandbox" element={<AiSandbox />} />
            <Route path="/dialer" element={<PowerDialer />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/marketing" element={<Marketing />} />
            <Route path="/vendors" element={<Vendors />} />
            <Route path="/partners" element={<Partners />} />
            <Route path="/social-media" element={<SocialMedia />} />
            <Route path="/campaign-match" element={<CampaignMatch />} />
            <Route path="/smart-audiences" element={<SmartAudiences />} />
            <Route path="/blog-posts" element={<BlogPosts />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/updates" element={<Updates />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/duplicates" element={<Duplicates />} />
            <Route path="/automations" element={<Automations />} />
            <Route path="/reporting" element={<Reporting />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
