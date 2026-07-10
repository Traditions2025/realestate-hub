// =====================================================================
// FOLLOW UP BOSS (FUB) — connection layer only (no lead/contact sync yet).
// FUB REST API: https://api.followupboss.com/v1
// Auth: HTTP Basic, API key as the username with an empty password.
// The key is read at call time from env FUB_API_KEY or the app_settings table
// (set via POST /api/fub/config). It is never stored in source control.
// =====================================================================
import { getSetting } from './database.js'

const FUB_API_URL = 'https://api.followupboss.com/v1'

export function fubKey() {
  return process.env.FUB_API_KEY || getSetting('fub_api_key') || null
}
export function fubConfigured() {
  return !!fubKey()
}

function authHeader() {
  const key = fubKey()
  if (!key) return null
  // Basic auth: base64("APIKEY:") — key is the username, blank password.
  return 'Basic ' + Buffer.from(key + ':').toString('base64')
}

export async function fubGet(endpoint, params = {}) {
  const auth = authHeader()
  if (!auth) throw new Error('Follow Up Boss API key not configured')
  const url = new URL(`${FUB_API_URL}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json',
      // X-System identifies this integration in FUB's logs (courtesy header).
      'X-System': 'MattSmithTeamHub',
    },
  })
  if (!resp.ok) {
    let body = ''
    try { body = (await resp.text()).slice(0, 300) } catch {}
    const err = new Error(`FUB API ${resp.status} ${resp.statusText}${body ? ' — ' + body : ''}`)
    err.status = resp.status
    throw err
  }
  return resp.json()
}

// Connection test — returns the account/user this key belongs to.
export async function fubIdentity() {
  return fubGet('/identity')
}
