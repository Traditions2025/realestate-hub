// Push a Hub tag change out to Sierra and Follow Up Boss.
//
// The Hub is master for tags the Hub owns, but a tag only earns its keep if the
// people working in Sierra and FUB can see it too. John, 2026-11-03: "we should be
// able to create tags in HUB that can sync to Sierra and FUB".
//
// The two APIs want opposite things, which is the whole reason this file exists:
//
//   Sierra  PUT /leads/{id} { tags: [...] }        ADDITIVE - assigns, never replaces
//           PUT /leads/{id} { removeTags: [...] }  names as STRINGS; tag objects 400
//   FUB     PUT /people/{id} { tags: [...] }       REPLACES the whole array, so the
//                                                  current set must be read and merged
//
// Get that backwards and Sierra silently no-ops or FUB wipes every tag the lead had.
//
// Both rate-limit. Sierra 429s under bursts (~800ms apart, ~6s backoff); FUB wants
// ~260ms between calls including READS. Callers pushing more than one lead must pace
// themselves - pushTagsForClient handles one lead and does not sleep on its own.
//
// The FUB half is guarded by namesAgree(). 411 FUB people are claimed by more than one
// Hub lead (project_fub_status_push), and a wrong link means tagging a stranger.
import db from './database.js'
import { sierraPut } from './sierra-helper.js'
import { fubGet, fubConfigured, fubUpdatePerson } from './fub-helper.js'
import { namesAgree } from './fub-status-push.js'

const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map(s => String(s || '').trim()).filter(Boolean))]
const lower = (list) => list.map(s => s.toLowerCase())

// Sierra is eventually consistent and rate-limited, so a failure here is reported,
// never thrown: the Hub row is already correct and must not be rolled back.
async function pushSierra(client, add, remove, dry) {
  if (!client.sierra_lead_id) return { ok: false, skipped: 'not a Sierra lead' }
  const done = []
  try {
    // Both shapes go in ONE PUT where possible - fewer calls, less 429 exposure.
    const body = {}
    if (add.length) body.tags = add
    if (remove.length) body.removeTags = remove
    if (dry) return { ok: true, dry: true, would_send: body }
    await sierraPut(`/leads/${client.sierra_lead_id}`, body)
    if (add.length) done.push('+' + add.join(', +'))
    if (remove.length) done.push('-' + remove.join(', -'))
    return { ok: true, applied: done.join(' ') }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) }
  }
}

// FUB replaces the array, so read -> merge -> write. The read is also where a wrong
// fub_person_id link is caught, before anything is written to a stranger's record.
async function pushFub(client, add, remove, dry) {
  if (!client.fub_person_id) return { ok: false, skipped: 'not linked to FUB' }
  if (!fubConfigured()) return { ok: false, skipped: 'FUB not configured' }
  try {
    const person = await fubGet(`/people/${client.fub_person_id}`, { fields: 'id,name,firstName,lastName,tags' })
    const theirName = person?.name || `${person?.firstName || ''} ${person?.lastName || ''}`.trim()
    const ourName = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    if (!namesAgree(ourName, theirName)) {
      return { ok: false, skipped: `FUB #${client.fub_person_id} is "${theirName}", not "${ourName}" - link looks wrong, nothing written` }
    }
    const current = Array.isArray(person?.tags) ? person.tags : []
    const removeLc = lower(remove)
    let next = current.filter(t => !removeLc.includes(String(t).toLowerCase()))
    for (const t of add) if (!next.some(x => String(x).toLowerCase() === t.toLowerCase())) next.push(t)
    if (next.length === current.length && next.every((t, i) => t === current[i])) {
      return { ok: true, dry: !!dry, applied: 'already matching', current }
    }
    if (dry) return { ok: true, dry: true, fub_name: theirName, current: current, would_send: next }
    await fubUpdatePerson(client.fub_person_id, { tags: next })   // full array: a PUT replaces it
    return { ok: true, applied: `${current.length} -> ${next.length} tags` }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) }
  }
}

/**
 * Mirror one lead's tag change into Sierra and FUB. The Hub row is expected to be
 * updated ALREADY - this only pushes outward, and a failure on either side leaves
 * the Hub correct and says so rather than unwinding anything.
 */
export async function pushTagsForClient(clientId, { add = [], remove = [], dry = false } = {}) {
  const cid = Number(clientId)
  const a = clean(add), r = clean(remove)
  if (!a.length && !r.length) return { client_id: cid, skipped: 'nothing to push' }

  const client = db.get('SELECT id, first_name, last_name, sierra_lead_id, fub_person_id FROM clients WHERE id = ?', [cid])
  if (!client) return { client_id: cid, error: 'client not found' }

  const sierra = await pushSierra(client, a, r, dry)
  const fub = await pushFub(client, a, r, dry)

  if (dry) return { client_id: cid, dry: true, name: `${client.first_name || ''} ${client.last_name || ''}`.trim(), add: a, remove: r, sierra, fub }

  const bits = []
  if (sierra.ok) bits.push('Sierra ok')
  else if (!sierra.skipped) bits.push(`Sierra FAILED (${sierra.error})`)
  if (fub.ok) bits.push('FUB ok')
  else if (!fub.skipped) bits.push(`FUB FAILED (${fub.error || fub.skipped})`)
  if (bits.length) {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['tags_pushed', 'client', cid,
       `Tags ${a.length ? '+[' + a.join(', ') + ']' : ''}${r.length ? ' -[' + r.join(', ') + ']' : ''} → ${bits.join(', ')}`])
  }
  return { client_id: cid, name: `${client.first_name || ''} ${client.last_name || ''}`.trim(), add: a, remove: r, sierra, fub }
}

// Pacing for a multi-lead push. Sierra's 429 is the tighter limit of the two.
export const TAG_PUSH_DELAY_MS = 800
export const TAG_PUSH_MAX_INLINE = 25
