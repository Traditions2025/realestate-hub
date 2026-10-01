// Pushing the Hub's status to Follow Up Boss.
//
// The Hub is master for status: a lead marked Junk here should not sit in FUB as New,
// where an agent works a lead somebody already disqualified. One direction only - nothing
// is pulled from FUB, which is what would create duplicates.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const { STATUS_TO_STAGE, PRIME_STAGE, stageFor, PUSH_TAG, candidates, pushOne, remaining, namesAgree } = await import('../server/fub-status-push.js')

const src = fs.readFileSync(new URL('../server/fub-status-push.js', import.meta.url), 'utf8')
const helper = fs.readFileSync(new URL('../server/fub-helper.js', import.meta.url), 'utf8')

// WIDENED 2026-10-01: it was Junk and Do Not Contact only. John asked for the two systems
// to read the same, after finding Mark McDermott Prime in the Hub and Seller (NURTURE) in
// FUB. The mapping follows where these people ALREADY sit in FUB, sampled first.
test('the mapping covers the statuses with a real FUB equivalent', () => {
  assert.equal(STATUS_TO_STAGE.junk, 'Dead')
  assert.equal(STATUS_TO_STAGE.donotcontact, 'Do not Contact')
  assert.equal(STATUS_TO_STAGE.closed, 'Past Client')          // 11 of 12 sampled already there
  assert.equal(STATUS_TO_STAGE.pending, 'Under Contract')
  assert.equal(STATUS_TO_STAGE.active, 'ACTIVE WITH AGENT')
  assert.equal(STATUS_TO_STAGE.not_in_market, 'Not in the Market')
  assert.equal(STATUS_TO_STAGE.watch, 'Watch')
})

// The one that must NOT be pushed: 28,676 people, about half staged 'Realist' in FUB,
// which records where the lead came from. The Hub's 'new' does not carry that.
test("'new' is deliberately absent, so the Realist source survives", () => {
  assert.equal(STATUS_TO_STAGE.new, undefined)
  assert.equal(stageFor({ status: 'new' }), null)
})

test('a couple of statuses with no clean equivalent are left alone', () => {
  for (const st of ['qualify', 'archived', 'none'])
    assert.equal(stageFor({ status: st }), null, `${st} should not be guessed at`)
})

// FUB splits this one by who the person is, and already does so.
test('prime follows the lead type, buyer or seller', () => {
  assert.equal(stageFor({ status: 'prime', type: 'seller' }), 'High Probability Sellers')
  assert.equal(stageFor({ status: 'prime', type: 'buyer' }), 'High Probability Buyer')
  assert.equal(stageFor({ status: 'PRIME', type: 'Seller' }), 'High Probability Sellers')
  // an unknown type must still land somewhere sensible rather than nowhere
  assert.equal(stageFor({ status: 'prime', type: '' }), PRIME_STAGE.buyer)
})

// CHANGED 2026-10-01: all but one stage already existed. FUB had no equivalent of Watch -
// those leads were scattered across Nurture, Seller (NURTURE) and six others - so that one
// is created. Creating a stage is additive and moves nobody by itself.
test('only the missing stage is created, and creation is additive', () => {
  const fn = src.slice(src.indexOf('export async function ensureStages'))
  assert.match(fn, /const missing = wanted\.filter\(w => !have\.has\(w\)\)/,
    'it must only create what is absent')
  assert.match(fn, /fubPost\('\/stages'/)
  assert.ok(!/DELETE|fubDelete/.test(fn), 'it never removes a stage')
})

test('nothing is ever pulled from FUB', () => {
  assert.ok(!/INSERT INTO clients/i.test(src), 'this module must never create a Hub lead')
  assert.match(src, /ONE DIRECTION ONLY/)
})

// CHANGED AGAIN 2026-10-01: creating a person in FUB is now wanted. The invariant that
// matters was never "no POST" - it is DIRECTION. Nothing is pulled FROM FUB into the Hub,
// and a person is only created after searching FUB for them.
test('a person is created only after FUB has been searched', () => {
  assert.match(src, /export async function linkOrCreateInFub/)
  assert.match(helper, /Nothing is pulled FROM FUB/)
  assert.match(src, /not in FUB/, 'a missing record on the status push is still reported, not created')
})

test('the write path is narrow: one person, no bulk, no delete', () => {
  assert.match(helper, /export async function fubPut/)
  assert.ok(!/fubDelete|method: 'DELETE'/.test(helper), 'no delete path should exist')
})

test('tags are merged, never replaced', () => {
  // FUB REPLACES the tag array on a PUT; sending only the new tag wipes the rest
  assert.match(src, /currentTags\.includes\(PUSH_TAG\) \? currentTags : \[\.\.\.currentTags, PUSH_TAG\]/)
  assert.match(helper, /FUB REPLACES the tag array/)
})

test('the push is tagged so FUB shows where the decision came from', () => {
  assert.equal(PUSH_TAG, 'Hub: status synced')
})

test('a lead with no FUB id is never considered', () => {
  const now = new Date().toISOString()
  const mk = (status, fub) => db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Push', 'T' + Math.random().toString(36).slice(2, 8), `p${Date.now()}${Math.random()}@x.com`,
     'buyer', status, fub, '[]', now, now]).lastInsertRowid

  const withId = mk('junk', '900001')
  const withoutId = mk('junk', null)
  const activeWithId = mk('new', '900002')
  const ids = candidates({ limit: 5000 }).map(c => c.id)
  assert.ok(ids.includes(withId), 'a Junk lead with a FUB id should be pushed')
  assert.ok(!ids.includes(withoutId), 'no FUB id means nothing to update')
  assert.ok(!ids.includes(activeWithId), 'an unmapped status must be left alone')
})

test('it is paced, because this is a live CRM', () => {
  assert.match(src, /delayMs = 260/)
  assert.match(src, /setTimeout\(s, delayMs\)/)
})

// The first dry run failed on 103 of 228 with a FUB 429. The pacing was inside an
// `if (!dryRun)`, but a dry run still READS every person to see their current stage, so
// the reads ran flat out.
test('a dry run is paced too, because it still reads every person from FUB', () => {
  assert.ok(!/if \(!dryRun\) await new Promise/.test(src),
    'pacing only the writes is what tripped the rate limit')
  const loop = src.slice(src.indexOf('for (const c of rows)'))
  assert.match(loop, /await new Promise\(s => setTimeout\(s, delayMs\)\)/)
})

// ── the six that would have lost something ───────────────────────────────────────────
// The dry run would have demoted a Past Client, a High Probability Seller and three
// Seller (NURTURE) records to Dead. John asked that Junk leads stop showing as ACTIVE or
// NEW in FUB; a past client is neither.
const mkClient = (status, fub) => {
  const now = new Date().toISOString()
  return db.get('SELECT * FROM clients WHERE id = ?', [db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Guard', 'T' + Math.random().toString(36).slice(2, 8), `g${Date.now()}${Math.random()}@x.com`,
     'buyer', status, fub, '[]', now, now]).lastInsertRowid])
}

test('a meaningful FUB stage is reported for review, not demoted', async () => {
  // asserted on the source, because stubbing a dynamic import mid-suite is more fragile
  // than the thing it would be testing
  assert.match(src, /PROTECTED_STAGE/)
  for (const stage of ['Past Client', 'Seller (NURTURE)', 'High Probability Sellers', 'Under Contract', 'Closed', 'PLATINUM CLIENTS'])
    assert.ok(/past client|closed|under contract|pending|nurture|high probability|platinum|vip/i.test(stage),
      `${stage} should be protected`)
  assert.match(src, /action: 'protected'/)
  assert.match(src, /review this one/)
})

test('ordinary stages are NOT protected, so the other 119 still push', () => {
  const re = /past client|closed|under contract|pending|nurture|high probability|platinum|vip/i
  for (const stage of ['Lead', 'New Lead', 'Trash', 'Expired', 'Cancelled', 'Homeowner', 'Attempted Contact',
                       'Realist', 'FSBO', 'Not in the Market', 'C - Cold 6+ Months', 'Foreclosures', ''])
    assert.ok(!re.test(stage), `${stage} is not a stage worth protecting from a Junk flag`)
})

test('the guard can be overridden deliberately, and is off by default', () => {
  assert.match(src, /pushOne\(client, \{ dryRun = false, force = false \} = \{\}\)/)
  assert.match(src, /PROTECTED_STAGE\.test\(currentStage\) && !force/)
})

test('a lead with no mapping is skipped before any FUB call', async () => {
  const c = mkClient('new', '900003')
  const r = await pushOne(c)
  assert.match(String(r.skipped), /no mapping/)
})

// ── resumable ────────────────────────────────────────────────────────────────────────
// The first live attempt sent all 228 in one request. It got 21 through, the request died,
// and nothing recorded where it had stopped. The cursor is on id, which is unique, so a
// resumed run neither skips nor repeats.
test('the cursor pages forward without skipping or repeating', () => {
  const now = new Date().toISOString()
  const mk = () => db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Cursor', 'T' + Math.random().toString(36).slice(2, 8), `c${Date.now()}${Math.random()}@x.com`,
     'buyer', 'junk', String(950000 + Math.floor(Math.random() * 9999)), '[]', now, now]).lastInsertRowid
  const made = [mk(), mk(), mk()].sort((a, b) => a - b)

  const seen = []
  let after = made[0] - 1
  for (let guard = 0; guard < 10; guard++) {
    const page = candidates({ limit: 1, afterId: after })
    if (!page.length) break
    seen.push(page[0].id)
    after = page[0].id
    if (after >= made[2]) break
  }
  assert.deepEqual(seen, made, 'one at a time, in order, no duplicates')
})

test('remaining() counts what is still ahead of the cursor', () => {
  const all = candidates({ limit: 5000 })
  assert.equal(remaining(0), all.length)
  if (all.length > 1) assert.equal(remaining(all[0].id), all.length - 1)
})

test('the cursor is recorded per lead, not only at the end', () => {
  // if it were only set on a clean finish, a request that dies loses its place - which is
  // exactly what happened on the first live run
  assert.match(src, /out\.last_id = c\.id/)
  const loop = src.slice(src.indexOf('for (const c of rows)'), src.indexOf('out.remaining = remaining'))
  assert.match(loop, /out\.last_id = c\.id/, 'the cursor must advance inside the loop')
})

test('a caller can tell when it is finished', () => {
  assert.match(src, /out\.done = out\.remaining === 0/)
})

// ── one FUB person, two Hub leads ─────────────────────────────────────────────────────
// Spotted in the held-back list: Hub 11 and Hub 31649 both carry fub_person_id 6456.
// Whichever pushes last wins, and the other quietly disagrees with FUB from then on.
test('duplicate FUB links are reported', async () => {
  const { duplicateLinks } = await import('../server/fub-status-push.js')
  const now = new Date().toISOString()
  const shared = String(970000 + Math.floor(Math.random() * 9999))
  const mk = (first) => db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [first, 'Twin', `t${Date.now()}${Math.random()}@x.com`, 'buyer', 'junk', shared, '[]', now, now]).lastInsertRowid
  const a = mk('First'), b = mk('Second')

  const row = duplicateLinks({ limit: 1000 }).find(r => String(r.fub_person_id) === shared)
  assert.ok(row, 'two Hub leads on one FUB id should be reported')
  assert.equal(row.n, 2)
  const listed = String(row.hub_ids).split(',')
  for (const id of [a, b]) assert.ok(listed.includes(String(id)), `Hub ${id} should be listed`)
})

test('the duplicate report is read-only', () => {
  const at = src.indexOf('export function duplicateLinks')
  const next = src.indexOf('export async function revertPush', at + 10)
  const fn = src.slice(at, next === -1 ? undefined : next)
  assert.match(fn, /SELECT/, 'the slice should hold the function body')
  assert.ok(!/UPDATE |DELETE |INSERT /i.test(fn), 'it reports duplicates, it does not merge them')
})

// ── the link itself can be wrong ──────────────────────────────────────────────────────
// duplicateLinks turned up groups holding UNRELATED names on one FUB id, e.g. FUB 484 is
// claimed by Alexandria Schmidt, Abagail Wells and Latonya Chalmers. Pushing one of those
// stamps a status onto a stranger's FUB record.
test('unmistakably different people do not agree', () => {
  for (const [a, b] of [
    ['Abagail Wells', 'Latonya Chalmers'],
    ['Jordan Larison', 'Steven Peacock'],
    ['Alexandria Schmidt', 'Abagail Wells'],
    ['Courtney Fox', 'Frank Di'],
  ]) assert.equal(namesAgree(a, b), false, `${a} / ${b} are different people`)
})

// Generous on purpose: a false mismatch blocks a legitimate push, so only clear-cut
// disagreements count.
test('nicknames, married names and reorderings still agree', () => {
  for (const [a, b] of [
    ['Thomas Lutz', 'Thomas Lutz'],
    ['Steve Smith', 'Steven Smith'],
    ['Mike Zoll', 'Michael Zoll'],
    ['Beth Blanchett', 'Preston Beth Blanchett'],
    ['William McCullough', 'Bill McCullough'],   // surname carries it
    ['Smith, Matt', 'Matt Smith'],
  ]) assert.equal(namesAgree(a, b), true, `${a} / ${b} should be treated as one person`)
})

test('a missing name never blocks a push', () => {
  // no name on either side is not evidence of a bad link
  assert.equal(namesAgree('', 'Wade Letter'), true)
  assert.equal(namesAgree('Wade Letter', ''), true)
  assert.equal(namesAgree('', ''), true)
})

test('a single initial is not treated as a match', () => {
  // one-letter tokens are dropped, so "A Wells" vs "A Chalmers" must not agree on "A"
  assert.equal(namesAgree('A Wells', 'A Chalmers'), false)
})

test('a mismatch is reported and nothing is written', () => {
  assert.match(src, /action: 'name-mismatch'/)
  assert.match(src, /the link is wrong, pushing would write to the wrong person/)
  const guard = src.slice(src.indexOf("!namesAgree(hubName, fubName)"), src.indexOf("const tags = currentTags"))
  assert.ok(!/fubUpdatePerson/.test(guard), 'the mismatch path must return before any write')
})

// The first live run pushed 183 leads before this guard existed. If any of those links
// were wrong, the record now carries our tag - and if the mismatch were checked AFTER
// already-matches, it would report as 'matching' and the damage would stay invisible.
test('a wrong link is checked before already-matches, so past damage is visible', () => {
  assert.ok(src.indexOf("action: 'name-mismatch'") < src.indexOf("action: 'already-matches'"),
    'a wrong link must never be reported as matching')
  assert.match(src, /already_pushed: currentTags\.includes\(PUSH_TAG\)/)
})

// ── putting back what the pre-guard run got wrong ─────────────────────────────────────
test('the revert is narrow: drops our tag, no delete, no lead creation', () => {
  const fn = src.slice(src.indexOf('export async function revertPush'))
  assert.match(fn, /currentTags\.filter\(t => t !== PUSH_TAG\)/)
  assert.ok(!/INSERT INTO clients/i.test(fn), 'it must not create or alter Hub leads')
  assert.ok(!/fubDelete|method: 'DELETE'/.test(fn), 'nothing is deleted')
  assert.match(fn, /stage \? \{ stage, tags \} : \{ tags \}/, 'stage is optional')
})

test('the revert records why it happened', () => {
  const fn = src.slice(src.indexOf('export async function revertPush'))
  assert.match(fn, /fub_push_reverted/)
  assert.match(fn, /wrong link/)
})

test('a revert dry run writes nothing', () => {
  const fn = src.slice(src.indexOf('export async function revertPush'))
  const before = fn.indexOf('if (dryRun) return out')
  assert.ok(before > 0, 'it must return before the write')
  // match a CALL, not the import destructure that names the same function
  assert.ok(!/fubUpdatePerson\(/.test(fn.slice(0, before)), 'no write may happen ahead of the dry-run return')
})

// The protection only covers a DEMOTION now. Overwriting a meaningful stage is the point
// of parity - a Prime lead SHOULD stop reading as Seller (NURTURE) - but dropping a Past
// Client to Dead still loses history (John, 2026-10-01).
test('the stage guard applies to demotions only', () => {
  assert.match(src, /const demoting = stage === 'Dead' \|\| stage === 'Do not Contact'/)
  assert.match(src, /if \(demoting && PROTECTED_STAGE\.test\(currentStage\) && !force\)/)
})

test('prime leads are considered for a push', () => {
  // candidates() keys off the mapping, and prime is computed rather than listed in it
  assert.match(src, /\[\.\.\.Object\.keys\(STATUS_TO_STAGE\), 'prime'\]/)
  assert.match(src, /SELECT id, first_name, last_name, email, status, type, fub_person_id/,
    'the prime split needs the lead type')
})

// ── new Hub leads go into FUB (John, 2026-10-01) ─────────────────────────────────────
// "when someone is added in HUB make sure they are also pushed in FUB". The duplicate
// rule was never about writing - it is about DIRECTION. Nothing is pulled FROM FUB.
test('FUB is searched before anything is created', () => {
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  const beforeCreate = fn.slice(0, fn.indexOf("// 3. genuinely new to FUB"))
  assert.match(beforeCreate, /fubGet\('\/people', \{ \[field\]: value/, 'it must look first')
  assert.match(beforeCreate, /\[\['email', email\], \['phone', phone\]\]/, 'both fields, in order')
  // a CALL, not the import destructure that names the same function
  assert.ok(!/fubPost\(/.test(beforeCreate), 'nothing may be created before the search')
})

test('a lead already in FUB is linked, not duplicated', () => {
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  assert.match(fn, /action: dryRun \? 'would-link' : 'linked'/)
  assert.match(fn, /UPDATE clients SET fub_person_id = \?/)
})

test('a lead with nothing to match on is skipped, not created', () => {
  // no email and no phone is the ONE case that could genuinely duplicate in FUB
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  assert.match(fn, /if \(!email && !phone\) return \{ \.\.\.out, action: 'skipped'/)
})

test('an unmapped status still lands somewhere sensible', () => {
  // 'new' is not in the mapping on purpose, but a brand-new FUB record needs a stage
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  assert.match(fn, /const stage = stageFor\(client\) \|\| 'Lead'/)
})

test('"moving forward" means a cutoff, not a backfill', () => {
  // there are ~14,000 older unlinked leads; the cutoff is stamped on first run
  const fn = src.slice(src.indexOf('export async function pushNewLeads'))
  assert.match(fn, /db\.getSetting\(PUSH_NEW_SINCE_KEY\)/)
  assert.match(fn, /cutoff = nowIso\(\)/)
  assert.match(src, /created_at >= \?/)
})

test('only leads with a way to be matched are considered', () => {
  const fn = src.slice(src.indexOf('export function unlinkedSince'))
  assert.match(fn, /COALESCE\(email,''\) != '' OR COALESCE\(phone,''\) != ''/)
  assert.match(fn, /fub_person_id IS NULL OR fub_person_id = ''/)
})

test('creating a person is paced and resumable like every other push', () => {
  const fn = src.slice(src.indexOf('export async function pushNewLeads'))
  assert.match(fn, /setTimeout\(s, delayMs\)/)
  assert.match(fn, /out\.last_id = c\.id/)
})

test('nothing is pulled FROM FUB into the Hub', () => {
  // the invariant the lifted guard used to stand for
  assert.ok(!/INSERT INTO clients/i.test(src), 'this module must never create a Hub lead')
  assert.match(helper, /Nothing is pulled FROM FUB/)
})

// ── it has to run by itself ──────────────────────────────────────────────────────────
test('the new-lead push runs hourly and ships OFF', () => {
  const sch = fs.readFileSync(new URL('../server/scheduler.js', import.meta.url), 'utf8')
  assert.match(sch, /async function checkFubNewLeadsTick\(\)/)
  assert.match(sch, /setInterval\(checkFubNewLeadsTick, 60 \* 60 \* 1000\)/)
  // every automation in this codebase ships disabled and is switched on deliberately
  assert.match(sch, /fub_push_new_enabled', '0'\) !== '1'\) return/)
})

test('the sweep catches every entry point rather than hooking each one', () => {
  const sch = fs.readFileSync(new URL('../server/scheduler.js', import.meta.url), 'utf8')
  const fn = sch.slice(sch.indexOf('async function checkFubNewLeadsTick'))
  assert.match(fn, /pushNewLeads\(\{ limit: 25 \}\)/, 'small batches: two FUB searches per lead')
  assert.ok(!/INSERT INTO clients/.test(fn))
})

// ── the duplicates I made, and the guard that stops the next one ─────────────────────
// First live run created FUB duplicates for Virgil Webb and Drew Christensen: the Hub held
// a second record for each with no email and a different phone, so neither the email nor
// the phone search matched and a new FUB person was made beside the one already there.
// Some of those existing FUB records have no email or phone at all - name is the ONLY way
// to find them.
test('a matching name blocks a create, even when email and phone miss', () => {
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  const beforeCreate = fn.slice(0, fn.indexOf('// 3. genuinely new to FUB'))
  assert.match(beforeCreate, /fubGet\('\/people', \{ name, limit: 3 \}\)/)
  assert.match(beforeCreate, /action: 'name-exists'/)
  assert.ok(!/fubPost\(/.test(beforeCreate), 'nothing may be created before every search')
})

test('a name match is reported, never merged', () => {
  // which of two records is real, and what happens to the other, is a human call
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  assert.match(fn, /review before creating another/)
  // the word 'merged' appears in the comment that explains it does not merge, so look
  // for an actual operation rather than the word
  assert.ok(!/fubDelete\(|fubPut\([^)]*merge/i.test(fn), 'it must not resolve the duplicate itself')
})

test('the name check uses the same generous comparison as the status push', () => {
  // a nickname or married name must not be treated as a different person here either
  const fn = src.slice(src.indexOf('export async function linkOrCreateInFub'))
  assert.match(fn, /namesAgree\(name, p\.name \|\| ''\)/)
})
