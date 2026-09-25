// Searching a phone number must work whatever format it is typed in, and must find
// alternate numbers too. Numbers are stored "(319) 551-6347", so before this the pasted
// forms people actually use returned nothing and the lead looked missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
import { phoneSearchDigits, phoneSearchClauses, digitsOnlySql } from '../server/phone-search.js'
await initDb()

let seq = 0
function mkClient(phone, alt = null) {
  const r = db.run('INSERT INTO clients (first_name, last_name, type, status, phone, alt_phones) VALUES (?,?,?,?,?,?)',
    ['PhoneTest', 'Lead' + (++seq), 'buyer', 'new', phone, alt])
  return Number(r.lastInsertRowid)
}

// The same predicate the Clients list builds, narrowed to one row so the assertion is exact.
function findsById(id, term) {
  const p = phoneSearchClauses(term)
  if (!p.clauses.length) return false
  const row = db.get(
    `SELECT id FROM clients WHERE id = ? AND (${p.clauses.join(' OR ')})`, [id, ...p.params])
  return !!row
}

test('a number is found however it is typed', () => {
  const id = mkClient('(319) 551-6347')
  for (const term of [
    '(319) 551-6347',   // exactly as stored
    '3195516347',       // pasted digits
    '319-551-6347',
    '319 551-6347',
    '319.551.6347',
    '(319)551-6347',
    '+13195516347',     // off a caller ID, with country code
    '1 (319) 551-6347',
    '551-6347',         // local part only
    '5516347',
  ]) assert.ok(findsById(id, term), `should find the lead when typed as "${term}"`)
})

test('alternate numbers are searchable', () => {
  const id = mkClient('(319) 555-1000', '(856) 656-9858, (555) 111-2222')
  assert.ok(findsById(id, '8566569858'), 'first alternate number')
  assert.ok(findsById(id, '(555) 111-2222'), 'second alternate number')
  assert.ok(findsById(id, '3195551000'), 'primary still found')
})

test('a different number is not matched', () => {
  const id = mkClient('(319) 551-6347')
  assert.ok(!findsById(id, '3195516348'), 'one digit off must not match')
  assert.ok(!findsById(id, '(563) 555-0000'), 'unrelated number must not match')
})

test('the comma between alternates is kept so numbers cannot run together', () => {
  const id = mkClient('(319) 555-2000', '(319) 111-2222, (319) 333-4444')
  // '2222' + '3193334444' would only match if the separator were stripped
  assert.ok(!findsById(id, '22223193334'), 'must not match across the separator')
})

test('non-phone terms are left alone', () => {
  for (const term of ['Danielle', '', '1056 NE 27th Street', '52403', 'matt@example.com'])
    assert.equal(phoneSearchDigits(term), '', `"${term}" should not be treated as a phone`)
  // a 7-digit local number still counts
  assert.equal(phoneSearchDigits('551-6347'), '5516347')
  // 11+ digits keep the last 10, so a country code still finds a locally-stored number
  assert.equal(phoneSearchDigits('+1 (319) 551-6347'), '3195516347')
})

test('the strip expression leaves bare digits', () => {
  const r = db.get(`SELECT ${digitsOnlySql("'+1 (319) 551-6347'")} AS d`)
  assert.equal(r.d, '13195516347')
})
