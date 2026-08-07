const BASE = '/api'

// ---- Platform + API origin (Capacitor-ready) -------------------------------
// The SAME frontend bundle runs on the web/PWA (served from the Render origin,
// so relative "/api/..." is same-origin and works) AND inside the native
// Capacitor shell (served from capacitor://localhost or http://localhost, where
// "/api/..." would hit the local shell instead of the backend). We detect the
// native shell at RUNTIME via the Capacitor global and, only then, resolve API
// calls against the absolute backend URL. Web behavior is completely unchanged.
export const isNativeApp = typeof window !== 'undefined' && !!(window.Capacitor && (
  typeof window.Capacitor.isNativePlatform === 'function' ? window.Capacitor.isNativePlatform() : (window.Capacitor.platform && window.Capacitor.platform !== 'web')
))
export const platform = isNativeApp
  ? ((window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'native')
  : (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches ? 'pwa' : 'web')

export const API_ORIGIN = (() => {
  if (!isNativeApp) return ''   // web / PWA: same-origin, no change
  try {
    const o = (typeof window !== 'undefined' && (window.__HUB_API_ORIGIN || localStorage.getItem('hub_api_origin')))
    if (o) return String(o).replace(/\/$/, '')     // dev override for pointing native at a local/staging backend
  } catch {}
  return 'https://realestate-hub-1rzu.onrender.com' // native default: production backend
})()

// Resolve any app URL (relative "/api/..." or already-absolute) to a fetchable URL.
export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path
  return API_ORIGIN + (String(path).startsWith('/') ? path : '/' + path)
}

function getToken() {
  return localStorage.getItem('mst_token') || ''
}

async function request(path, options = {}) {
  const token = getToken()
  const res = await fetch(apiUrl(`${BASE}${path}`), {
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (res.status === 401) {
    // Token expired or invalid — force re-login
    localStorage.removeItem('mst_token')
    window.location.reload()
    throw new Error('Unauthorized')
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export const api = {
  // Dashboard
  dashboard: () => request('/dashboard'),

  // Transactions
  getTransactions: (params) => request('/transactions?' + new URLSearchParams(params || {})),
  getTransaction: (id) => request(`/transactions/${id}`),
  createTransaction: (data) => request('/transactions', { method: 'POST', body: data }),
  updateTransaction: (id, data) => request(`/transactions/${id}`, { method: 'PUT', body: data }),
  deleteTransaction: (id) => request(`/transactions/${id}`, { method: 'DELETE' }),

  // Clients
  getClients: (params) => request('/clients?' + new URLSearchParams(params || {})),
  getClientsPaged: async (params) => {
    const token = getToken()
    const url = apiUrl(`${BASE}/clients?` + new URLSearchParams(params || {}))
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json', 'x-auth-token': token } })
    if (res.status === 401) { localStorage.removeItem('mst_token'); window.location.reload(); throw new Error('Unauthorized') }
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    const data = await res.json()
    return {
      rows: data,
      total: Number(res.headers.get('X-Total-Count') || 0),
      limit: Number(res.headers.get('X-Page-Limit') || 100),
      offset: Number(res.headers.get('X-Page-Offset') || 0),
    }
  },
  getClient: (id) => request(`/clients/${id}`),
  createClient: (data) => request('/clients', { method: 'POST', body: data }),
  updateClient: (id, data) => request(`/clients/${id}`, { method: 'PUT', body: data }),
  deleteClient: (id) => request(`/clients/${id}`, { method: 'DELETE' }),

  // Tasks
  getTasks: (params) => request('/tasks?' + new URLSearchParams(params || {})),
  getTask: (id) => request(`/tasks/${id}`),
  createTask: (data) => request('/tasks', { method: 'POST', body: data }),
  updateTask: (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: data }),
  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),

  // Projects
  getProjects: (params) => request('/projects?' + new URLSearchParams(params || {})),
  getProject: (id) => request(`/projects/${id}`),
  createProject: (data) => request('/projects', { method: 'POST', body: data }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: data }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  // Notes
  getNotes: (params) => request('/notes?' + new URLSearchParams(params || {})),
  getNote: (id) => request(`/notes/${id}`),
  createNote: (data) => request('/notes', { method: 'POST', body: data }),
  updateNote: (id, data) => request(`/notes/${id}`, { method: 'PUT', body: data }),
  deleteNote: (id) => request(`/notes/${id}`, { method: 'DELETE' }),

  // Marketing
  getMarketing: (params) => request('/marketing?' + new URLSearchParams(params || {})),
  getCampaign: (id) => request(`/marketing/${id}`),
  createCampaign: (data) => request('/marketing', { method: 'POST', body: data }),
  updateCampaign: (id, data) => request(`/marketing/${id}`, { method: 'PUT', body: data }),
  deleteCampaign: (id) => request(`/marketing/${id}`, { method: 'DELETE' }),

  // Showings
  getShowings: (params) => request('/showings?' + new URLSearchParams(params || {})),
  createShowing: (data) => request('/showings', { method: 'POST', body: data }),
  updateShowing: (id, data) => request(`/showings/${id}`, { method: 'PUT', body: data }),
  deleteShowing: (id) => request(`/showings/${id}`, { method: 'DELETE' }),

  // Activity
  getActivity: (limit) => request(`/activity?limit=${limit || 20}`),
}

// Export for pages that use fetch() directly
export function authFetch(url, options = {}) {
  const token = getToken()
  return fetch(apiUrl(url), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
      ...options.headers,
    },
  }).then(res => {
    if (res.status === 401) {
      localStorage.removeItem('mst_token')
      window.location.reload()
    }
    return res
  })
}
