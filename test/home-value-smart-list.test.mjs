// The "Home Value · Requested" smart list (John, 2026-10-28): everyone who has asked what
// their home is worth online, excluding Dead and Do Not Contact.
//
// Two sources are OR'd because neither alone is the whole set — the activity_log row the
// intake writes, and the site tag it adds at the same moment. On 2026-10-28 only 20 leads
// carried the tag, which is why the log is in there too.
import test from 'node:test'
import assert from 'node:assert'
import db, { initDb } from '../server/database.js'

await initDb()
const { SMART_LIST_SQL } = await import('../server/routes/clients.js')

const SQL = SMART_LIST_SQL.home_value_requested
const BASE = 996400
let seq = 0
const TAG = 'cedarrapidsmetroareahomevalue.sierrasellersites.com'

function mk({ status = 'new', tags = '[]', optOut = 0 } = {}) {
  const id = BASE + (++seq)
  db.run('DELETE FROM activity_log WHERE entity_type=? AND entity_id=?', ['client', id])
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, status, type, tags, hub_text_opt_out, created_at, updated_at)
          VALUES (?,?,?,?, 'seller', ?, ?, datetime('now'), datetime('now'))`,
  [id, 'HV', 'List' + seq, status, tags, optOut])
  return id
}
const submitted = (id, n = 1) => {
  for (let i = 0; i < n; i++) {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['home_value_submission', 'client', id, `hv_test_${id}_${i}`])
  }
}
const inList = (id) => !!db.get(`SELECT 1 FROM clients WHERE merged_into IS NULL AND id=? AND ${SQL}`, [id])

test('a submission in the activity log puts them on the list', () => {
  const id = mk(); submitted(id)
  assert.equal(inList(id), true)
})

test('the site tag alone is enough — a Sierra sync can bring it without the intake running', () => {
  const id = mk({ tags: JSON.stringify(['Import', TAG]) })
  assert.equal(inList(id), true)
})

test('someone who never asked is not on it', () => {
  const id = mk({ tags: JSON.stringify(['Realist', 'Homeowner']) })
  assert.equal(inList(id), false)
})

test('a repeat requester appears once, not once per submission', () => {
  const id = mk(); submitted(id, 4)
  const n = db.get(`SELECT COUNT(*) c FROM clients WHERE merged_into IS NULL AND id=? AND ${SQL}`, [id]).c
  assert.equal(n, 1)
})

// ---- the exclusions John asked for ----

test('Dead (junk) is excluded even with a submission on file', () => {
  const id = mk({ status: 'junk' }); submitted(id)
  assert.equal(inList(id), false)
})

test('Do Not Contact is excluded even with a submission on file', () => {
  const id = mk({ status: 'donotcontact' }); submitted(id)
  assert.equal(inList(id), false)
})

test('an archived or merged record never shows', () => {
  const id = mk({ status: 'archived' }); submitted(id)
  assert.equal(inList(id), false)
  const m = mk(); submitted(m)
  db.run('UPDATE clients SET merged_into=? WHERE id=?', [id, m])
  assert.equal(inList(m), false)
})

test('a TEXT opt-out still counts — they asked what the house is worth, and this campaign is email', () => {
  const id = mk({ optOut: 1 }); submitted(id)
  assert.equal(inList(id), true, 'hub_text_opt_out must not drop someone from an email list')
})

test('another kind of activity_log row does not count as a request', () => {
  const id = mk()
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
    ['home_value_deferred', 'client', id, 'campaign stepped aside'])
  assert.equal(inList(id), false)
})

test('a log row for a different entity type does not leak in', () => {
  const id = mk()
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
    ['home_value_submission', 'transaction', id, 'not a client row'])
  assert.equal(inList(id), false)
})

// The team's own records stay off the list (John, 2026-10-28). He test-submitted the form
// on 2026-10-08 and landed on his own lead list. The submission row is true history and is
// kept; the tag is what removes him, so a future test needs only the tag.
test('a record tagged "Internal - Not a Lead" is excluded even with a real submission', () => {
  const id = mk({ tags: JSON.stringify(['cedarrapidsmetroareahomevalue.sierrasellersites.com', 'Internal - Not a Lead']) })
  submitted(id)
  assert.equal(inList(id), false)
})

test('the exclusion does not swallow an ordinary lead whose tags merely mention leads', () => {
  const id = mk({ tags: JSON.stringify(['Lead Ad', 'Buyer Lead', 'Website Form']) })
  submitted(id)
  assert.equal(inList(id), true, 'only the exact "Not a Lead" phrase excludes')
})
