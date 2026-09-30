// Push the Hub's status to Follow Up Boss.
//
// The Hub is master for status. A lead marked Junk or Do Not Contact here should not be
// sitting in FUB as New or Active, where an agent picks it up and works a lead somebody
// already disqualified (John, 2026-09-30).
//
// ONE DIRECTION ONLY. Nothing is ever pulled from FUB into the Hub — that is what would
// create duplicates. The only FUB data that enters the Hub is Facebook ad leads, which
// arrive by email and already dedupe on phone then email before inserting.
//
// The mapping uses stages FUB ALREADY HAS rather than inventing a parallel vocabulary:
//
//     Hub Junk          ->  FUB "Dead"            (15,919 people already there)
//     Hub DoNotContact  ->  FUB "Do not Contact"  (285)
//
// Only these two are pushed. The rest of the Hub's statuses — New, Prime, Watch, Qualify,
// Pending — have no FUB equivalent, and inventing one would mean guessing at how the team
// uses FUB's pipeline. Adding more mappings later is a line in STATUS_TO_STAGE.
import db from './database.js'

export const STATUS_TO_STAGE = {
  junk: 'Dead',
  donotcontact: 'Do not Contact',
}

// Written onto the FUB record so anyone looking there can see where the decision came
// from, rather than wondering why a lead went quiet.
export const PUSH_TAG = 'Hub: status synced'

// FUB stages that mean something a Junk flag should not silently erase.
//
// The dry run surfaced six of these: a Past Client, a High Probability Seller and three
// Seller (NURTURE) records, all marked Junk in the Hub. John's ask was that Junk leads
// stop showing as ACTIVE or NEW in FUB - a past client is neither, and demoting one to
// Dead loses history nobody asked to lose. These are reported for a person to look at
// instead of being pushed.
const PROTECTED_STAGE = /past client|closed|under contract|pending|nurture|high probability/i

const nowIso = () => new Date().toISOString()
const norm = (s) => String(s || '').trim().toLowerCase()

/** Leads whose Hub status should be reflected in FUB, and that have a FUB record. */
export function candidates({ limit = 1000 } = {}) {
  const statuses = Object.keys(STATUS_TO_STAGE)
  return db.all(
    `SELECT id, first_name, last_name, email, status, fub_person_id, tags
       FROM clients
      WHERE merged_into IS NULL
        AND fub_person_id IS NOT NULL AND fub_person_id != ''
        AND lower(trim(status)) IN (${statuses.map(() => '?').join(',')})
      ORDER BY id LIMIT ?`, [...statuses, Number(limit)])
}

/**
 * Push one lead. Reads the FUB record first, because a PUT REPLACES the tag array and
 * sending only the new tag would wipe everything else on the record.
 */
export async function pushOne(client, { dryRun = false, force = false } = {}) {
  const stage = STATUS_TO_STAGE[norm(client.status)]
  if (!stage) return { client_id: client.id, skipped: 'no mapping for ' + client.status }
  const personId = Number(client.fub_person_id)
  if (!personId) return { client_id: client.id, skipped: 'no fub id' }

  const { fubGet, fubUpdatePerson } = await import('./fub-helper.js')
  let person
  try {
    person = await fubGet(`/people/${personId}`)
  } catch (e) {
    // A 404 means the record is gone from FUB. Say so rather than creating one: this
    // module never creates people, only updates them.
    return { client_id: client.id, fub_id: personId, error: e.status === 404 ? 'not in FUB' : e.message }
  }

  const currentStage = String(person?.stage || '')
  const currentTags = Array.isArray(person?.tags) ? person.tags : []
  if (currentStage === stage && currentTags.includes(PUSH_TAG))
    return { client_id: client.id, fub_id: personId, action: 'already-matches', stage }

  if (PROTECTED_STAGE.test(currentStage) && !force) {
    return {
      client_id: client.id, fub_id: personId,
      name: `${client.first_name || ''} ${client.last_name || ''}`.trim(),
      hub_status: client.status, from_stage: currentStage, to_stage: stage,
      action: 'protected',
      why: `${currentStage} carries history a Junk flag should not erase — review this one`,
    }
  }

  const tags = currentTags.includes(PUSH_TAG) ? currentTags : [...currentTags, PUSH_TAG]
  const result = {
    client_id: client.id, fub_id: personId,
    name: `${client.first_name || ''} ${client.last_name || ''}`.trim(),
    hub_status: client.status, from_stage: currentStage || '(none)', to_stage: stage,
    action: dryRun ? 'would-update' : 'updated',
  }
  if (dryRun) return result

  try {
    await fubUpdatePerson(personId, { stage, tags })
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['fub_status_pushed', 'client', client.id,
       `FUB stage ${currentStage || '(none)'} -> ${stage} (Hub status ${client.status})`])
    return result
  } catch (e) {
    return { ...result, action: 'failed', error: e.message }
  }
}

/**
 * Push a batch. Paced deliberately: FUB rate-limits, and this is somebody's live CRM
 * rather than a scratch database.
 */
export async function pushStatuses({ dryRun = false, limit = 1000, delayMs = 260, force = false } = {}) {
  const rows = candidates({ limit })
  const out = { considered: rows.length, updated: 0, unchanged: 0, failed: 0, missing: 0, protected: 0, results: [], dry: dryRun }
  for (const c of rows) {
    const r = await pushOne(c, { dryRun, force })
    if (r.action === 'updated' || r.action === 'would-update') out.updated++
    else if (r.action === 'already-matches') out.unchanged++
    else if (r.action === 'protected') out.protected++
    else if (r.error === 'not in FUB') out.missing++
    else if (r.error || r.action === 'failed') out.failed++
    if (r.action !== 'already-matches') out.results.push(r)
    // EVERY pass is paced, including a dry run: the dry run still reads each person from
    // FUB, and pacing only the writes is what hit the rate limit on 103 of 228.
    await new Promise(s => setTimeout(s, delayMs))
  }
  if (!dryRun && out.updated) {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['fub_status_push_run', 'system', null, `${out.updated} updated, ${out.failed} failed, ${out.missing} missing`])
  }
  return out
}
