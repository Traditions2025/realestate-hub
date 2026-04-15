import React, { useState, useEffect } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import LoginScreen from './components/LoginScreen'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import PreListings from './pages/PreListings'
import Clients from './pages/Clients'
import Tasks from './pages/Tasks'
import Projects from './pages/Projects'
import Notes from './pages/Notes'
import Marketing from './pages/Marketing'
import Vendors from './pages/Vendors'
import Partners from './pages/Partners'
import SocialMedia from './pages/SocialMedia'
import Calendar from './pages/Calendar'

const navSections = [
  { label: 'MAIN', items: [
    { path: '/', label: 'Dashboard', icon: '\u229E' },
    { path: '/calendar', label: 'Calendar', icon: '\u2630' },
  ]},
  { label: 'PIPELINE', items: [
    { path: '/transactions', label: 'Transactions', icon: '\u21C4' },
    { path: '/pre-listings', label: 'Pre-Listings', icon: '\u2302' },
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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('mst_token')
    if (!token) { setChecking(false); return }
    fetch('/api/auth/verify', { headers: { 'x-auth-token': token } })
      .then(r => { if (r.ok) setAuthed(true); else localStorage.removeItem('mst_token') })
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  if (checking) return <div className="login-screen"><div className="login-card"><p>Loading...</p></div></div>
  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />

  return (
    <div className="app-layout">
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <div className="sidebar-header">
          <div className="logo">
            {sidebarOpen ? (
              <img src="/logo.png" alt="Matt Smith Team" className="logo-img" />
            ) : (
              <img src="/logo.png" alt="MST" className="logo-img-small" />
            )}
          </div>
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '\u2039' : '\u203A'}
          </button>
        </div>
        <nav className="sidebar-nav">
          {navSections.map(section => (
            <div key={section.label} className="nav-section">
              {sidebarOpen && <div className="nav-section-label">{section.label}</div>}
              {section.items.map(item => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {sidebarOpen && <span className="nav-label">{item.label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {sidebarOpen && (
          <div className="sidebar-footer">
            <div className="team-sub">RE/MAX Concepts &middot; Cedar Rapids IA</div>
          </div>
        )}
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/pre-listings" element={<PreListings />} />
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
      </main>
    </div>
  )
}
