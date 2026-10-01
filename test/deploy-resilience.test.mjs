// Surviving a deploy.
//
// John: "when we make updates the site becomes unavailable for a few minutes then we have
// to hard refresh". The cause was not the server being slow to boot — it was that fetch()
// only REJECTS on a network failure, never on an HTTP error. Render's 502 came back as a
// perfectly good Response, the catch never ran, the cached shell was never used, and the
// error page was handed straight to the user.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')

test('the cache name was bumped, so the new worker actually activates', () => {
  assert.match(sw, /const CACHE_NAME = 'mst-hub-v9'/)
})

test('old caches are purged on activate', () => {
  assert.match(sw, /keys\.filter\(k => k !== CACHE_NAME\)\.map\(k => caches\.delete\(k\)\)/)
})

test('a navigation only caches and returns a 200', () => {
  const nav = sw.slice(sw.lastIndexOf('const cache = await caches.open(CACHE_NAME)'))
  assert.match(nav, /if \(fresh && fresh\.status === 200\) \{ cache\.put/)
})

test('a 5xx during a deploy falls back to the cached shell', () => {
  const nav = sw.slice(sw.lastIndexOf('const cache = await caches.open(CACHE_NAME)'))
  assert.match(nav, /return \(await fromCache\(\)\) \|\| fresh/,
    'a non-OK response must not be handed to the user when a shell is cached')
  assert.match(nav, /cache\.match\('\/index\.html'\)/, 'the shell is the last resort')
})

test('a failed asset fetch is retried once before giving up', () => {
  // one missed chunk white-screens a tab until a hard refresh
  assert.match(sw, /await new Promise\(r => setTimeout\(r, 1200\)\)/)
  assert.match(sw, /if \(!fresh\.ok\) throw new Error\('status ' \+ fresh\.status\)/)
})

test('API calls are never cached', () => {
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)[\s\S]{0,120}fetch\(event\.request\)/)
})

test('the client checks for a new version often, and on focus', () => {
  assert.match(main, /setInterval\(check, 2 \* 60 \* 1000\)/, 'hourly was too slow to matter')
  assert.match(main, /visibilitychange/, 'coming back to the tab should pick up a deploy')
})

test('a controller change still reloads exactly once', () => {
  // reloadOnce guards with sessionStorage; a reload loop would be worse than a stale tab
  assert.match(main, /controllerchange'?, \(\) => reloadOnce\('sw_reloaded'\)/)
  assert.match(main, /sessionStorage\.getItem\(key\)/)
})

// ── the softphone, which the same deploy takes down ───────────────────────────────────
// John, 2026-10-01: "The Hub phone is not connected yet." Setup was attempted exactly
// once. A restarting server answers /api/voice/token with an HTML error page, r.json()
// throws, deviceRef stays null, and the phone is dead until someone reloads by hand -
// even though the server is healthy again seconds later. The token endpoint was verified
// healthy while that toast was showing, which is what pointed at the client.
const widget = fs.readFileSync(new URL('../src/components/CallWidget.jsx', import.meta.url), 'utf8')

test('phone setup is retried rather than attempted once', () => {
  assert.match(widget, /const scheduleRetry = \(\) =>/)
  assert.match(widget, /const DELAYS = \[2000, 4000, 8000, 15000, 30000\]/)
  // the old one-shot call, with nothing watching for failure, must be gone
  assert.ok(!/^\s*init\(\)\s*$/m.test(widget), 'a bare init() with no retry is the bug')
  assert.match(widget, /ensureDevice\(\)\.catch\(\(\) => scheduleRetry\(\)\)/)
})

test('only one setup runs at a time, and callers share it', () => {
  const fn = widget.slice(widget.indexOf('const ensureDevice'), widget.indexOf('const scheduleRetry'))
  assert.match(fn, /if \(deviceRef\.current\) return Promise\.resolve/)
  assert.match(fn, /if \(initRef\.current\) return initRef\.current/)
  assert.match(fn, /\.finally\(\(\) => \{ initRef\.current = null \}\)/)
})

test('a failed setup leaves no half-built device behind', () => {
  // ensureDevice treats a non-null deviceRef as working, so a Device that failed to
  // register must not be left in it
  const start = widget.indexOf('await device.register()')
  const fn = widget.slice(start, start + 420)
  assert.match(fn, /deviceRef\.current = null/)
  assert.match(fn, /throw e/, 'the failure has to reach the retry')
})

test('coming back to the tab or back online retries immediately', () => {
  assert.match(widget, /window\.addEventListener\('online', retryNow\)/)
  assert.match(widget, /document\.addEventListener\('visibilitychange', retryNow\)/)
  assert.match(widget, /attemptRef\.current = 0/, 'the backoff resets on a deliberate retry')
})

test('the listeners and the pending timer are cleaned up', () => {
  const cleanup = widget.slice(widget.lastIndexOf('return () => {'))
  assert.match(cleanup, /clearTimeout\(retryRef\.current\)/)
  assert.match(cleanup, /removeEventListener\('online', retryNow\)/)
  assert.match(cleanup, /removeEventListener\('visibilitychange', retryNow\)/)
})

test('pressing Call connects on demand instead of only complaining', () => {
  const fn = widget.slice(widget.indexOf('window.hubCall = async'))
  assert.match(fn, /device = await ensureDevice\(\)/, 'Call should try to connect first')
  // the toast is now the last resort, and it says it is retrying
  assert.match(fn, /Retrying/)
  assert.ok(fn.indexOf('await ensureDevice()') < fn.indexOf('notify('),
    'it must attempt setup BEFORE telling the user it is not connected')
})

test('the reason is read from a ref, not a stale closure', () => {
  // the setup effect runs once with [], so a captured regErr would never update
  assert.match(widget, /const regErrRef = useRef\(''\)/)
  assert.match(widget, /const setRegErr = \(v\) => \{ regErrRef\.current = v \|\| ''; _setRegErr\(v\) \}/)
  assert.match(widget, /regErrRef\.current\s*\n?\s*\?/, 'the toast reads the ref')
})
