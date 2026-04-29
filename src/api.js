const BASE = '/api'

function getToken() {
  return localStorage.getItem('mst_token') || ''
}

async function request(path, options = {}) {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
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
    const url = `${BASE}/clients?` + new URLSearchParams(params || {})
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
  return fetch(url, {
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
