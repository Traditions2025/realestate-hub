import React, { useState, useEffect, lazy, Suspense } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import LoginScreen from './components/LoginScreen'
import CallWidget from './components/CallWidget'

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
const BlogPosts = lazy(() => import('./pages/BlogPosts'))
const Calendar = lazy(() => import('./pages/Calendar'))
const Updates = lazy(() => import('./pages/Updates'))
const Inbox = lazy(() => import('./pages/Inbox'))
const PowerDialer = lazy(() => import('./pages/PowerDialer'))
const AiOpportunities = lazy(() => import('./pages/AiOpportunities'))
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
        <Suspense fallback={<div className="page-loading">Loading...</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/ai-opportunities" element={<AiOpportunities />} />
            <Route path="/dialer" element={<PowerDialer />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/marketing" element={<Marketing />} />
            <Route path="/vendors" element={<Vendors />} />
            <Route path="/partners" element={<Partners />} />
            <Route path="/social-media" element={<SocialMedia />} />
            <Route path="/campaign-match" element={<CampaignMatch />} />
            <Route path="/blog-posts" element={<BlogPosts />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/updates" element={<Updates />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/automations" element={<Automations />} />
            <Route path="/reporting" element={<Reporting />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
