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

// HUB status -> FUB stage. Built so the two systems read the same and nobody has to
// translate between them (John, 2026-10-01: "Mark McDermott shows Prime in HUB but in FUB
// he shows as Seller (NURTURE)").
//
// The mapping is NOT guesswork - it follows where these people already sit in FUB, sampled
// before any of it was written:
//   closed  -> Past Client        (11 of 12 already there)
//   pending -> Under Contract     (1 of 1)
//   active  -> ACTIVE WITH AGENT  (5 of 10; FUB's own word for a working lead)
//   not_in_market -> Not in the Market
//   watch   -> Watch              (CREATED for this; FUB had no equivalent and those leads
//                                  were scattered across Nurture, Seller (NURTURE) and six more)
//
// DELIBERATELY ABSENT:
//   new     - 28,676 people, and in FUB about half are staged 'Realist', which records
//             where the lead came from. Hub's 'new' does not carry that, so pushing would
//             flatten ~20,000 records and lose the source for good (John's call).
//   qualify, archived - a couple of people each and no clean FUB equivalent; guessing one
//             would misfile them for no benefit.
export const STATUS_TO_STAGE = {
  junk: 'Dead',
  donotcontact: 'Do not Contact',
  closed: 'Past Client',
  pending: 'Under Contract',
  active: 'ACTIVE WITH AGENT',
  not_in_market: 'Not in the Market',
  watch: 'Watch',
}

// 'prime' is the one status FUB splits by who the person is, and it already does so:
// High Probability Buyer vs High Probability Sellers. Taking the Hub's type keeps that
// distinction instead of flattening both into one stage.
export const PRIME_STAGE = { buyer: 'High Probability Buyer', seller: 'High Probability Sellers' }

/** The FUB stage this lead should hold, or null when the Hub status is not mapped. */
export function stageFor(client) {
  const st = String(client?.status || '').trim().toLowerCase()
  if (st === 'prime') {
    const t = String(client?.type || '').trim().toLowerCase()
    return PRIME_STAGE[t] || PRIME_STAGE.buyer
  }
  return STATUS_TO_STAGE[st] || null
}

// The stage that has to exist in FUB before a push can use it. Everything else in the
// mapping was already in the account.
export const STAGE_TO_CREATE = 'Watch'

// Written onto the FUB record so anyone looking there can see where the decision came
// from, rather than wondering why a lead went quiet.
export const PUSH_TAG = 'Hub: status synced'

// FUB stages that mean something a Junk flag should not silently erase.
//
// The dry run surfaced 14 of these: seven Past Clients, a High Probability Seller, four
// Seller (NURTURE)/Nurture records and a PLATINUM CLIENT, all marked Junk or DNC in the
// Hub. John's ask was that Junk leads stop showing as ACTIVE or NEW in FUB - a past client
// is neither, and demoting one to Dead loses history nobody asked to lose. These are
// reported for a person to look at instead of being pushed.
//
// Stages that are merely INACTIVE are not protected and do push: Realist, FSBO, Expired,
// Cancelled, Not in the Market, C - Cold 6+ Months, Foreclosures. None of those carry a
// relationship a Junk flag would contradict.
const PROTECTED_STAGE = /past client|closed|under contract|pending|nurture|high probability|platinum|vip/i

const nowIso = () => new Date().toISOString()
const norm = (s) => String(s || '').trim().toLowerCase()

/**
 * Do these two names plausibly belong to the same person?
 *
 * Deliberately generous: a nickname, a married name, a missing middle initial or a
 * reordered name should all still count as agreeing. It only needs to catch the case
 * where the two names are unmistakably DIFFERENT people, because that means the
 * fub_person_id link is wrong.
 */
export function namesAgree(a, b) {
  const parts = (v) => norm(v).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1)
  const A = parts(a), B = parts(b)
  if (!A.length || !B.length) return true            // nothing to compare on
  const shared = A.filter(w => B.includes(w))
  if (shared.length) return true                      // any surname or first name in common
  // a shortened first name still agrees: Abagail/Abby, Michael/Mike
  return A.some(x => B.some(y => (x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= 3))
}

/**
 * Leads whose Hub status should be reflected in FUB, and that have a FUB record.
 *
 * Ordered by id and cursored on it, so a run can be done in short chunks. The first live
 * attempt ran all 228 in one request, got 21 through, and then the request died with no
 * way to tell where it had stopped. id is unique, so `afterId` never skips or repeats.
 */
export function candidates({ limit = 1000, afterId = 0 } = {}) {
  const statuses = [...Object.keys(STATUS_TO_STAGE), 'prime']
  return db.all(
    `SELECT id, first_name, last_name, email, status, type, fub_person_id, tags
       FROM clients
      WHERE merged_into IS NULL
        AND fub_person_id IS NOT NULL AND fub_person_id != ''
        AND lower(trim(status)) IN (${statuses.map(() => '?').join(',')})
        AND id > ?
      ORDER BY id LIMIT ?`, [...statuses, Number(afterId) || 0, Number(limit)])
}

/** How many are left to look at from a cursor — so a caller knows when it is done. */
export function remaining(afterId = 0) {
  const statuses = [...Object.keys(STATUS_TO_STAGE), 'prime']
  return db.get(
    `SELECT COUNT(*) n FROM clients
      WHERE merged_into IS NULL
        AND fub_person_id IS NOT NULL AND fub_person_id != ''
        AND lower(trim(status)) IN (${statuses.map(() => '?').join(',')})
        AND id > ?`, [...statuses, Number(afterId) || 0]).n
}

/**
 * Push one lead. Reads the FUB record first, because a PUT REPLACES the tag array and
 * sending only the new tag would wipe everything else on the record.
 */
export async function pushOne(client, { dryRun = false, force = false } = {}) {
  const stage = stageFor(client)
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
  const fubName = String(person?.name || [person?.firstName, person?.lastName].filter(Boolean).join(' ') || '').trim()
  const hubName = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  // If the Hub name and the FUB name are different PEOPLE, the link itself is wrong and
  // pushing would stamp a status onto a stranger's record. 411 FUB people are claimed by
  // more than one Hub lead (see duplicateLinks) and some of those groups hold unrelated
  // names, so this is a real condition rather than a theoretical one.
  if (!force && fubName && hubName && !namesAgree(hubName, fubName)) {
    return {
      client_id: client.id, fub_id: personId, name: hubName, fub_name: fubName,
      hub_status: client.status, from_stage: currentStage, to_stage: stage,
      action: 'name-mismatch',
      already_pushed: currentTags.includes(PUSH_TAG),   // true = an earlier run wrote to this wrong record
      why: `Hub has "${hubName}", FUB ${personId} is "${fubName}" — the link is wrong, pushing would write to the wrong person`,
    }
  }


  if (currentStage === stage && currentTags.includes(PUSH_TAG))
    return { client_id: client.id, fub_id: personId, action: 'already-matches', stage }

  // The guard now applies ONLY to a demotion. Overwriting a meaningful stage is the whole
  // point of the parity push - a Prime lead SHOULD stop reading as Seller (NURTURE) - but
  // dropping a Past Client to Dead still loses history nobody asked to lose, so Dead and
  // Do not Contact keep the protection (John, 2026-10-01).
  const demoting = stage === 'Dead' || stage === 'Do not Contact'
  if (demoting && PROTECTED_STAGE.test(currentStage) && !force) {
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
export async function pushStatuses({ dryRun = false, limit = 1000, delayMs = 260, force = false, afterId = 0 } = {}) {
  const rows = candidates({ limit, afterId })
  const out = { considered: rows.length, updated: 0, unchanged: 0, failed: 0, missing: 0, protected: 0, mismatched: 0,
                results: [], dry: dryRun, after_id: Number(afterId) || 0, last_id: Number(afterId) || 0 }
  for (const c of rows) {
    const r = await pushOne(c, { dryRun, force })
    if (r.action === 'updated' || r.action === 'would-update') out.updated++
    else if (r.action === 'already-matches') out.unchanged++
    else if (r.action === 'protected') out.protected++
    else if (r.action === 'name-mismatch') out.mismatched++
    else if (r.error === 'not in FUB') out.missing++
    else if (r.error || r.action === 'failed') out.failed++
    if (r.action !== 'already-matches') out.results.push(r)
    out.last_id = c.id   // the cursor to resume from, even if the request dies here
    // EVERY pass is paced, including a dry run: the dry run still reads each person from
    // FUB, and pacing only the writes is what hit the rate limit on 103 of 228.
    await new Promise(s => setTimeout(s, delayMs))
  }
  out.remaining = remaining(out.last_id)
  out.done = out.remaining === 0
  if (!dryRun && out.updated) {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['fub_status_push_run', 'system', null, `${out.updated} updated, ${out.failed} failed, ${out.missing} missing`])
  }
  return out
}

/**
 * FUB people that more than one Hub lead points at.
 *
 * Found while reviewing the held-back list: Hub 11 and Hub 31649 both carry
 * fub_person_id 6456. When two Hub leads map to one FUB person, whichever pushes last
 * wins and the other silently disagrees with FUB from then on. Read-only - this reports
 * them, it does not merge anything.
 */
export function duplicateLinks({ limit = 200 } = {}) {
  return db.all(
    `SELECT fub_person_id, COUNT(*) n,
            GROUP_CONCAT(id) hub_ids,
            GROUP_CONCAT(trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ' | ') names,
            GROUP_CONCAT(COALESCE(status,''), ' | ') statuses
       FROM clients
      WHERE merged_into IS NULL
        AND fub_person_id IS NOT NULL AND fub_person_id != ''
      GROUP BY fub_person_id
     HAVING COUNT(*) > 1
      ORDER BY n DESC, fub_person_id
      LIMIT ?`, [Number(limit)])
}

/**
 * Put back a FUB record this module wrote to in error.
 *
 * Three leads were pushed before the name guard existed, onto FUB people who are someone
 * else entirely (Hub "Fidel Taylor" -> FUB 14739 "Ghyslaine June", and two more). Only one
 * of the three had its stage actually changed; the other two were already Dead and only
 * picked up our tag.
 *
 * Narrow on purpose: it takes the FUB id and the stage to restore, removes PUSH_TAG so the
 * record no longer claims the Hub agreed with it, and touches nothing else. `stage` is
 * optional - omit it to drop the tag and leave the stage alone.
 */
export async function revertPush(fubId, { stage = null, dryRun = false } = {}) {
  const personId = Number(fubId)
  if (!personId) return { error: 'no fub id' }
  const { fubGet, fubUpdatePerson } = await import('./fub-helper.js')
  let person
  try { person = await fubGet(`/people/${personId}`) }
  catch (e) { return { fub_id: personId, error: e.status === 404 ? 'not in FUB' : e.message } }

  const name = String(person?.name || [person?.firstName, person?.lastName].filter(Boolean).join(' ') || '').trim()
  const currentTags = Array.isArray(person?.tags) ? person.tags : []
  const tags = currentTags.filter(t => t !== PUSH_TAG)
  const out = {
    fub_id: personId, fub_name: name,
    stage_now: String(person?.stage || ''), stage_restoring_to: stage || '(left alone)',
    tag_removed: currentTags.length !== tags.length,
    action: dryRun ? 'would-revert' : 'reverted',
  }
  if (dryRun) return out
  try {
    // tags always go back as the full array, since a PUT replaces it
    await fubUpdatePerson(personId, stage ? { stage, tags } : { tags })
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['fub_push_reverted', 'system', null,
       `FUB ${personId} (${name}): stage -> ${stage || 'unchanged'}, Hub tag removed (wrong link)`])
    return out
  } catch (e) { return { ...out, action: 'failed', error: e.message } }
}

/**
 * Make sure every stage the mapping needs exists in FUB.
 *
 * Only 'Watch' is missing — the rest of the mapping follows stages the account already
 * had. Creating a stage is additive and affects nobody until a lead is moved into it.
 */
export async function ensureStages({ dryRun = false } = {}) {
  const { fubGet, fubPost } = await import('./fub-helper.js')
  const d = await fubGet('/stages', { limit: 100 })
  const have = new Set((d?.stages || []).map(x => String(x.name)))
  const wanted = [...new Set([...Object.values(STATUS_TO_STAGE), ...Object.values(PRIME_STAGE)])]
  const missing = wanted.filter(w => !have.has(w))
  const out = { existing: have.size, wanted, missing, created: [], dry: dryRun }
  if (dryRun || !missing.length) return out
  for (const name of missing) {
    try { await fubPost('/stages', { name }); out.created.push(name) }
    catch (e) { out.error = `${name}: ${String(e.message).slice(0, 120)}`; break }
    await new Promise(s => setTimeout(s, 300))
  }
  return out
}
