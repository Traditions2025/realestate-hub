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
