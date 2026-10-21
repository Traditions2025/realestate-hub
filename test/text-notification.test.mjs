// A text arriving should be noticeable: a sound in the Hub, and an email.
//
// John, 2026-10-21: "can you create a notification sound when we get a text from HUB
// something like a tweet sound also I need see why text notification I've been getting on
// email did not go to my email johnwithmattsmithteam@gmail.com"
//
// The email answer was that NO address was wrong — the Hub had never sent a text alert
// email at all. An inbound text raised the in-app bell and a web push and stopped there.
// Whatever text alerts he had been getting came from another system.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const chirpSrc = fs.readFileSync(new URL('../src/lib/chirp.js', import.meta.url), 'utf8')
const appSrc = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const gmailSrc = fs.readFileSync(new URL('../server/gmail-inbox.js', import.meta.url), 'utf8')
const inboxSrc = fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
const notifSrc = fs.readFileSync(new URL('../server/notifications.js', import.meta.url), 'utf8')

// ── the sound ────────────────────────────────────────────────────────────────────────
test('the chirp is synthesised, not a hosted audio file', () => {
  assert.match(chirpSrc, /createOscillator/)
  assert.ok(!/\.mp3|\.wav|new Audio\(/.test(chirpSrc),
    'a file would need hosting and could be blocked; this has neither problem')
})

test('it is two rising notes — what makes it read as a chirp, not a beep', () => {
  assert.equal((chirpSrc.match(/note\(ac, master/g) || []).length, 2)
  assert.match(chirpSrc, /exponentialRampToValueAtTime/)
})

test('it fades in and out, so it does not click', () => {
  const fn = chirpSrc.slice(chirpSrc.indexOf('function note('), chirpSrc.indexOf('export function chirp'))
  assert.match(fn, /gain\.gain\.exponentialRampToValueAtTime\(peak/)
  assert.match(fn, /gain\.gain\.exponentialRampToValueAtTime\(0\.0001, t \+ dur\)/)
})

test('it is short, and audible across a room without being shrill', () => {
  // raised 0.18 -> 0.42 on 2026-10-21; the ceiling keeps it from becoming something
  // you switch off by Wednesday
  const vol = Number(/volume = ([\d.]+)/.exec(chirpSrc)[1])
  assert.ok(vol >= 0.3 && vol <= 0.6, `volume ${vol} is outside the usable range`)
  const durs = [...chirpSrc.matchAll(/note\(ac, master, [^,]+, \d+, \d+, ([\d.]+)/g)].map(m => Number(m[1]))
  assert.ok(durs.length === 2 && durs.every(d => d <= 0.12), `notes too long: ${durs}`)
})

test('a browser refusing to play audio is not treated as an error', () => {
  assert.match(chirpSrc, /catch \{ return false \}/)
  assert.match(chirpSrc, /if \(ac\.state === 'suspended'\) ac\.resume\(\)\.catch\(\(\) => \{\}\)/,
    'a backgrounded tab suspends the context')
})

test('mute is per browser and defaults to ON when storage fails', () => {
  assert.match(chirpSrc, /catch \{ return true \}/,
    'a silent notifier is worse than an unwanted noise — you never find out it is broken')
  assert.match(chirpSrc, /localStorage\.setItem\(KEY/)
})

// ── only a text makes the sound ──────────────────────────────────────────────────────
test('the bell reports WHAT arrived, not just how many', () => {
  assert.match(notifSrc, /export function latestUnread\(\)/)
  assert.match(notifSrc, /SELECT id, type, title FROM notifications WHERE read = 0 ORDER BY id DESC LIMIT 1/)
})

test('only a new inbound text chirps', () => {
  assert.match(appSrc, /latest\.type === 'inbound_text'\) chirpIfEnabled\(\)/)
})

test('a backup report or campaign response stays silent', () => {
  // the type check is part of the same condition, not a separate branch that could drift
  const line = appSrc.split(String.fromCharCode(10)).find(l => l.includes('chirpIfEnabled()'))
  assert.match(line, /latest\.id > prev/)
  assert.match(line, /latest\.type === 'inbound_text'/)
})

test('opening the Hub with old unread texts does not play anything', () => {
  assert.match(appSrc, /prev !== null && latest/,
    'the first poll seeds the marker instead of firing for everything already waiting')
  assert.match(appSrc, /const lastSeenRef = useRef\(null\)/)
})

test('turning the sound on previews it, which also unlocks audio', () => {
  // browsers require a user gesture before audio; the toggle click IS that gesture
  assert.match(appSrc, /setSoundEnabled\(!soundOn\); setSoundOn\(on\); if \(on\) chirp\(\)/)
})

// ── the email that never existed ─────────────────────────────────────────────────────
// The email alert for an inbound text is notifyInboundText() in routes/inbox.js, and it
// has existed all along. On 2026-10-21 I added a SECOND one, having searched for the
// sender and missed the first; John's screenshot showed Matt receiving both. Removed the
// same day. These tests now guard that there is exactly ONE.
test('exactly one place emails on an inbound text', () => {
  assert.match(inboxSrc, /async function notifyInboundText\(client, body, fromPhone\)/)
  assert.ok(!/notifyNewText/.test(inboxSrc), 'the duplicate must stay gone')
  // One definition, called from the SMS webhook and the two group-text paths. What
  // matters is that no SECOND notifier exists alongside it.
  assert.match(inboxSrc, /notifyInboundText\(client, body \|\| \(media\.length \? '\[media\]' : ''\), from\)/)
})

test('its recipients are a setting that DEFAULTS to John, plus an always-CC', () => {
  const fn = inboxSrc.slice(inboxSrc.indexOf('async function notifyInboundText'))
  assert.match(fn, /getSetting\('inbox_notify_email', 'johnwithmattsmithteam@gmail\.com'\)/)
  assert.match(fn, /getSetting\('inbox_notify_always_cc', 'mattsmithremax@gmail\.com'\)/)
})

test('a blank setting would silently cut the main recipient — worth knowing', () => {
  // getSetting returns the STORED value when the row exists, so an empty string is not
  // the default. Both rows are currently absent, which is why John is still addressed.
  const fn = inboxSrc.slice(inboxSrc.indexOf('async function notifyInboundText'))
  assert.match(fn, /\|\| ''/, 'the fallback to empty string is the trapdoor to remember')
})
