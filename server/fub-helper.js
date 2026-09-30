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

// ── WRITING to FUB ───────────────────────────────────────────────────────────────────
// The Hub had no write path at all until now, and that was a reasonable default: FUB is
// a live system the team works out of. Everything below is therefore deliberately narrow
// — it updates ONE person by id, and nothing else. There is no bulk endpoint here and no
// delete, because neither is needed for a status push and both are easy to regret.
//
// Direction is one way. The Hub is master for status; leads are never pulled FROM FUB,
// which is what would create duplicates (John, 2026-09-30).
export async function fubPut(endpoint, body) {
  const auth = authHeader()
  if (!auth) throw new Error('Follow Up Boss API key not configured')
  const resp = await fetch(`${FUB_API_URL}${endpoint}`, {
    method: 'PUT',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'X-System': 'MattSmithTeamHub' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    let text = ''
    try { text = (await resp.text()).slice(0, 300) } catch {}
    const err = new Error(`FUB API ${resp.status} ${resp.statusText}${text ? ' — ' + text : ''}`)
    err.status = resp.status
    throw err
  }
  return resp.json()
}

/** Update one person's stage and/or tags. Returns the updated person. */
export async function fubUpdatePerson(personId, { stage = null, tags = null } = {}) {
  const body = {}
  if (stage) body.stage = String(stage)
  // FUB REPLACES the tag array on a PUT, so the caller must pass the full set it wants
  // kept. Sending only the new tag would silently wipe every other tag on the record.
  if (Array.isArray(tags)) body.tags = tags
  if (!Object.keys(body).length) throw new Error('nothing to update')
  return fubPut(`/people/${Number(personId)}`, body)
}

// Connection test — returns the account/user this key belongs to.
export async function fubIdentity() {
  return fubGet('/identity')
}
