// The softphone must not depend on a third-party CDN to exist.
//
// John, 2026-10-05: "The Hub phone could not connect: Phone SDK failed to load."
// The build was fine and jsdelivr was serving the file (200, 301902 bytes) - his browser
// just could not fetch it. The SDK was never an npm dependency, so jsdelivr was the only
// source, which made someone else's CDN a single point of failure for the phone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const widget = fs.readFileSync(new URL('../src/components/CallWidget.jsx', import.meta.url), 'utf8')
const VENDOR = new URL('../public/vendor/twilio-voice-2.18.3.min.js', import.meta.url)

test('the SDK is served from the Hub, not fetched from a CDN first', () => {
  const tag = html.slice(html.indexOf('<script defer src="/vendor/'))
  assert.ok(tag.startsWith('<script defer src="/vendor/twilio-voice-'), 'the primary src must be same-origin')
  // and the CDN must not be the one the browser reaches for first
  const localAt = html.indexOf('/vendor/twilio-voice-')
  const cdnAt = html.indexOf('cdn.jsdelivr.net')
  assert.ok(localAt > 0 && localAt < cdnAt, 'the local copy has to come before the CDN fallback')
})

test('the vendored file is actually there and is the real SDK', () => {
  assert.ok(fs.existsSync(VENDOR), 'public/vendor/twilio-voice-2.18.3.min.js must be committed')
  const js = fs.readFileSync(VENDOR, 'utf8')
  assert.ok(js.length > 250000, 'a truncated download would load and then do nothing')
  assert.match(js, /Twilio/, 'must contain the Twilio bundle')
})

test('the version in the filename matches the version the fallback asks for', () => {
  const local = (html.match(/\/vendor\/twilio-voice-([\d.]+)\.min\.js/) || [])[1]
  const cdn = (html.match(/voice-sdk@([\d.]+)\//) || [])[1]
  assert.ok(local, 'local src must carry its version')
  assert.equal(local, cdn, 'the fallback must not silently serve a different version')
})

test('a missing local file falls back to the CDN instead of leaving no phone', () => {
  const tag = html.slice(html.indexOf('<script defer src="/vendor/'), html.indexOf('</head>'))
  assert.match(tag, /onerror=/, 'a deploy without the vendor file must still get a phone')
  assert.match(tag, /cdn\.jsdelivr\.net/)
  assert.match(tag, /createElement\('script'\)/)
})

test('the error tells the user what actually blocks it', () => {
  // "Phone SDK failed to load" sent John looking at the Hub. Same-origin now means the
  // cause is in the browser, so the message should say so.
  const i = widget.indexOf('await waitForSdk()')
  const block = widget.slice(i, i + 600)
  assert.match(block, /ad blocker|VPN/i, 'name the usual cause rather than just the symptom')
})

test('the SDK load is still retried rather than failing once', () => {
  // a deploy restart used to kill the phone permanently; init must throw to the retry
  const i = widget.indexOf('await waitForSdk()')
  assert.match(widget.slice(i, i + 600), /throw new Error\('sdk'\)/)
})
