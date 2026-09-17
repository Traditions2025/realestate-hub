// FB ad opener bank — John's exact approved copy (2026-09-17), field mapping,
// intro rotation, website tail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const t = await import('../server/ai-followup/fb-ad-templates.js')

test('12 templates, every one carries the exact approved skeleton + website tail', () => {
  assert.equal(t.FB_AD_TEMPLATES.length, 12)
  const client = { first_name: 'Bev' }
  db.setSetting('fb_ad_tpl_rot', '0'); db.setSetting('fb_ad_intro_rot', '0')
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    const r = t.renderFbAdOpener(client, '510 Broadway St', { advance: true })
    seen.add(r.key)
    assert.ok(r.text.includes('Bev'), 'first name substituted')
    assert.ok(r.text.includes('510 Broadway St'), 'property substituted')
    assert.ok(r.text.endsWith('You can see more homes at www.mattsmithteam.com'), 'website tail on ' + r.key)
    assert.ok(/Matt Smith Team at RE\/MAX/.test(r.text), 'brand present')
    assert.ok(!/%[INP]/.test(r.text), 'no unrendered tokens in ' + r.key)
    assert.ok(!/\{\{/.test(r.text), 'no template braces in ' + r.key)
  }
  assert.equal(seen.size, 12, 'rotation covers all 12 templates')
})

test('exact copy check on the first template (simple + direct)', () => {
  db.setSetting('fb_ad_tpl_rot', '0'); db.setSetting('fb_ad_intro_rot', '0')
  const r = t.renderFbAdOpener({ first_name: 'Sara' }, '100 S Hill Crest Cir', { advance: false })
  assert.equal(r.text,
    "Hi Sara, it's John with Matt Smith Team at RE/MAX :) You were checking out 100 S Hill Crest Cir on Facebook. Were you interested in that home specifically, or mostly just browsing? You can see more homes at www.mattsmithteam.com")
})

test('intro rotation: Hi, Hello, then time-of-day', () => {
  assert.equal(t.introVariant(0), 'Hi')
  assert.equal(t.introVariant(1), 'Hello')
  assert.ok(['Good morning', 'Good afternoon', 'Hello'].includes(t.introVariant(2)), 'slot 3 is time-of-day')
})

test('graceful fallbacks: missing name and property never render broken text', () => {
  const r = t.renderFbAdOpener({}, '', { advance: false })
  assert.ok(r.text.includes('there,') || r.text.includes('there '), 'name fallback')
  assert.ok(r.text.includes('the home you saw'), 'property fallback')
})

test('no-reply follow-up email renders about their inquiry', () => {
  const r = t.renderFbAdEmail({ first_name: 'Rich' }, '510 Broadway Springville')
  assert.equal(r.subject, 'Your inquiry on 510 Broadway Springville')
  assert.ok(r.body.includes('Hi Rich'))
  assert.ok(r.body.includes('You asked about 510 Broadway Springville on Facebook'))
  assert.ok(r.body.includes('Matt Smith here with RE/MAX'), 'emails identify as Matt Smith')
  assert.ok(!/John here|it's John/.test(r.body), 'emails NEVER introduce as John')
  assert.ok(r.body.includes('www.mattsmithteam.com'))
  assert.ok(r.body.includes('(319) 343-1562'))
  assert.ok(!/[—–]/.test(r.body), 'no em/en dashes in client-facing copy')
})
