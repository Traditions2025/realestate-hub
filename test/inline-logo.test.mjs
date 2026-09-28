// The logo must ride along inside the message rather than being fetched when the email
// opens, which is what made it appear a second or two late. These pin the swap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const SRC = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')

test('the small email logo exists and is much lighter than the original', () => {
  const small = fs.statSync(new URL('../public/email-logo.jpg', import.meta.url)).size
  const orig = fs.statSync(new URL('../public/logo.jpg', import.meta.url)).size
  assert.ok(small > 3000, 'the file should be real artwork, not a stub')
  assert.ok(small < orig * 0.5, `email logo ${small}B should be well under half the original ${orig}B`)
})

test('both hosted logo URLs are swapped, so an older template is covered too', () => {
  assert.match(SRC, /logo\.jpg'/, 'the original URL must still be recognised')
  assert.match(SRC, /email-logo\.jpg'/, 'the new URL must be recognised')
})

test('the attachment is inline with a content_id, not a file to download', () => {
  assert.match(SRC, /disposition: 'inline'/)
  assert.match(SRC, /content_id: EMAIL_LOGO_CID/)
})

test('a caller can still send a normal attachment, and its disposition is respected', () => {
  assert.match(SRC, /disposition: a\.disposition \|\| 'attachment'/)
})

test('a missing logo file leaves the hosted URL alone rather than breaking the send', () => {
  // the read is wrapped so a missing file returns the html untouched
  assert.match(SRC, /catch \{ return \{ html, attachment: null \} \}/)
})

test('the logo is read from disk once, not per email', () => {
  assert.match(SRC, /let _logoB64 = null/)
  assert.match(SRC, /if \(_logoB64 === null\)/)
})
