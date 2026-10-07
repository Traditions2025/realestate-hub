// A literal route has to be registered before the ':id' that would swallow it.
//
// GET /api/drips/performance-all was added after router.get('/:id'), so Express matched
// it as id = "performance-all", Number() made that NaN, and the lookup 404'd. The symptom
// was not an error anyone would read as a routing bug: a poll loop just never saw the
// response it was waiting for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../server/routes/drips.js', import.meta.url), 'utf8')

// every GET route in the file, in registration order
const routes = [...src.matchAll(/router\.get\('([^']+)'/g)].map((m, i) => ({ path: m[1], order: i, at: m.index }))

test('performance-all is registered before /:id', () => {
  const lit = routes.find(r => r.path === '/performance-all')
  const id = routes.find(r => r.path === '/:id')
  assert.ok(lit, 'the route must exist')
  assert.ok(id, "there is a '/:id' route to be shadowed by")
  assert.ok(lit.order < id.order,
    "'/:id' matches any single segment, so it must come after every literal one-segment route")
})

test('no single-segment literal GET route is shadowed by a parameter route', () => {
  // the general rule, so the next one added is caught too
  const param = routes.filter(r => /^\/:[^/]+$/.test(r.path))
  const literal = routes.filter(r => /^\/[a-z0-9-]+$/i.test(r.path))
  for (const p of param) {
    for (const l of literal) {
      assert.ok(l.order < p.order,
        `GET ${l.path} is registered after ${p.path} and can never be reached`)
    }
  }
})

// ── the SQL has to actually run ──────────────────────────────────────────────────────
// Reading the source only proves a query was WRITTEN. The first version of this endpoint
// selected `active` from drip_campaigns, a column that does not exist - the table has no
// on/off flag, a campaign runs because something enrolls into it. Every source-reading
// test passed and the endpoint 500'd on the first real call.
test('every SELECT in performance-all runs against the real schema', async () => {
  const { default: db, initDb } = await import('../server/database.js')
  await initDb()
  const i = src.indexOf("router.get('/performance-all'")
  const fn = src.slice(i, src.indexOf("router.get('/:id'", i))
  // each query is a whole string literal: stop at its own closing delimiter, or the match
  // runs on into the next one and produces SQL nobody wrote
  const queries = [...fn.matchAll(/(['`])(SELECT[\s\S]*?)\1/g)].map(m => m[2].trim())
  assert.ok(queries.length >= 2, 'expected to find the endpoint queries, found ' + queries.length)
  for (const q of queries) {
    // the templated ones carry ${w} and placeholders; strip the template hole, keep the ?s
    const sql = q.replace(/\$\{w\}/g, '').replace(/\$\{[^}]*\}/g, '')
    const params = (sql.match(/\?/g) || []).map(() => 1)
    assert.doesNotThrow(() => db.all(sql, params), 'this query does not run: ' + sql.slice(0, 90))
  }
})

test('the route still returns the totals it is for', () => {
  const i = src.indexOf("router.get('/performance-all'")
  const fn = src.slice(i, src.indexOf("router.get('/:id'", i))
  for (const k of ['on_drip_now', 'ever_enrolled', 'open_rate_pct', 'campaigns_with_people']) {
    assert.ok(fn.includes(k), `missing ${k}`)
  }
})

test('enrolment counts ignore `since`, email counts respect it', () => {
  // "on a drip right now" is not a windowed question; mixing the two would give a
  // number that means neither
  const i = src.indexOf("router.get('/performance-all'")
  const fn = src.slice(i, src.indexOf("router.get('/:id'", i))
  const enrol = fn.slice(fn.indexOf('FROM drip_enrollments'))
  assert.ok(!enrol.slice(0, 200).includes('sent_at >='), 'enrolment counts must not be windowed')
  assert.match(fn, /const w = since \? ' AND sent_at >= \?' : ''/)
})
