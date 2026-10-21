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

test('it is short and quiet — this fires all day', () => {
  assert.match(chirpSrc, /volume = 0\.1[0-9]/)
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
test('an inbound text now sends an email', () => {
  assert.match(gmailSrc, /export async function notifyNewText\(client, body, fromNumber\)/)
  assert.match(inboxSrc, /m\.notifyNewText\(client, body, from\)/)
})

test('it goes to the same people as the inbound-email alert, John included', () => {
  assert.match(gmailSrc, /johnwithmattsmithteam@gmail\.com/)
  const fn = gmailSrc.slice(gmailSrc.indexOf('export async function notifyNewText'))
  assert.match(fn, /BASE_NOTIFY_RECIPIENTS \+ ',' \+ extra/,
    'same base pair plus the same configurable extras')
})

test('it can be switched off without a deploy', () => {
  assert.match(gmailSrc, /text_notify_email_enabled/)
})

test('it never blocks storing the message', () => {
  const line = inboxSrc.split(String.fromCharCode(10)).find(l => l.includes('notifyNewText'))
  assert.match(line, /\.catch\(\(\) => \{\}\)/, 'fire and forget')
  assert.ok(!/await .*notifyNewText/.test(inboxSrc),
    'awaiting it would hold up the campaign guards that run below')
})

test('a media-only text still says something useful', () => {
  const fn = gmailSrc.slice(gmailSrc.indexOf('export async function notifyNewText'))
  assert.match(fn, /\[photo or media\]/)
})

test('the subject carries the message, so it is readable from a lock screen', () => {
  const fn = gmailSrc.slice(gmailSrc.indexOf('export async function notifyNewText'))
  assert.match(fn, /\$\{name\} texted: "\$\{short\}"/)
  assert.match(fn, /text\.length > 90/, 'truncated, or a long text wrecks the subject line')
})
