import React, { useState, useEffect, lazy, Suspense } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import LoginScreen from './components/LoginScreen'

// Lazy load pages so initial bundle is smaller
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Transactions = lazy(() => import('./pages/Transactions'))
const PreListings = lazy(() => import('./pages/PreListings'))
const Listings = lazy(() => import('./pages/Listings'))
const Clients = lazy(() => import('./pages/Clients'))
const Tasks = lazy(() => import('./pages/Tasks'))
const Projects = lazy(() => import('./pages/Projects'))
const Notes = lazy(() => import('./pages/Notes'))
const Marketing = lazy(() => import('./pages/Marketing'))
const Vendors = lazy(() => import('./pages/Vendors'))
const Partners = lazy(() => import('./pages/Partners'))
const SocialMedia = lazy(() => import('./pages/SocialMedia'))
const Calendar = lazy(() => import('./pages/Calendar'))

const navSections = [
  { label: 'MAIN', items: [
    { path: '/', label: 'Dashboard', icon: '\u229E' },
    { path: '/calendar', label: 'Calendar', icon: '\u2630' },
  ]},
  { label: 'PIPELINE', items: [
    { path: '/transactions', label: 'Transactions', icon: '\u21C4' },
    { path: '/pre-listings', label: 'Pre-Listings', icon: '\u2302' },
    { path: '/listings', label: 'Listings', icon: '\u2605' },
    { path: '/clients', label: 'Clients', icon: '\u25C9' },
  ]},
  { label: 'WORK', items: [
    { path: '/tasks', label: 'Tasks', icon: '\u2610' },
    { path: '/projects', label: 'Projects', icon: '\u25A6' },
    { path: '/notes', label: 'Notes', icon: '\u2261' },
  ]},
  { label: 'MARKETING', items: [
    { path: '/marketing', label: 'Campaigns', icon: '\u25C8' },
    { path: '/social-media', label: 'Social Media', icon: '\u2600' },
  ]},
  { label: 'DIRECTORY', items: [
    { path: '/vendors', label: 'Vendors', icon: '\u2692' },
    { path: '/partners', label: 'Partners', icon: '\u2694' },
  ]},
]

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Optimistically authed if we have a token - skip the verify roundtrip on page load
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('mst_token'))

  useEffect(() => {
    const token = localStorage.getItem('mst_token')
    if (!token) return
    // Background verify - if it fails, an actual API call will redirect to login
    fetch('/api/auth/verify', { headers: { 'x-auth-token': token } })
      .then(r => { if (!r.ok) { localStorage.removeItem('mst_token'); setAuthed(false) } })
      .catch(() => {})
  }, [])

  // Close sidebar on navigation (mobile)
  const closeSidebar = () => {
    if (window.innerWidth <= 768) setSidebarOpen(false)
  }

  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />

  return (
    <div className="app-layout">
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

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="logo">
            <img src="/logo.png" alt="Matt Smith Team" className="logo-img" />
          </div>
          <button className="sidebar-toggle desktop-only" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '\u2039' : '\u203A'}
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
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  onClick={closeSidebar}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="team-sub">RE/MAX Concepts &middot; Cedar Rapids IA</div>
        </div>
      </aside>

      <main className="main-content">
        <Suspense fallback={<div className="page-loading">Loading...</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/pre-listings" element={<PreListings />} />
            <Route path="/listings" element={<Listings />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/marketing" element={<Marketing />} />
            <Route path="/vendors" element={<Vendors />} />
            <Route path="/partners" element={<Partners />} />
            <Route path="/social-media" element={<SocialMedia />} />
            <Route path="/calendar" element={<Calendar />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
