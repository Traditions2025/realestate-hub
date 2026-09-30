// FUB lead-notification email trigger — parser tested against the REAL email
// formats observed in Matt's inbox on 2026-09-17 (new vs alert, Facebook only,
// Zillow and Hot Sheet ignored).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const f = await import('../server/fub-leads.js')

// A phone nobody is using yet.
//
// These fixtures used to build a number from four timestamp digits: '(319) 555-' + last
// four. That is a 10,000-value space, and a long-lived dev database already holds 12,460
// leads on a (319) 555-xxxx number, so a collision was certain. ingestFbLead dedupes on
// phone, so the test got handed an existing BUYER instead of creating its seller, and the
// suite failed for reasons that had nothing to do with the code under test.
function freshPhone() {
  for (let i = 0; i < 200; i++) {
    const exch = 200 + Math.floor(Math.random() * 700)      // a valid NXX, not just 555
    const line = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    const p = `(319) ${exch}-${line}`
    const digits = '1319' + exch + line
    const taken = db.get(
      "SELECT 1 FROM clients WHERE replace(replace(replace(replace(COALESCE(phone,''),'(',''),')',''),'-',''),' ','') LIKE ?",
      ['%' + exch + line])
    if (!taken) return { pretty: p, e164: '+' + digits }
  }
  throw new Error('could not find an unused phone')
}

test('NEW Facebook lead email parses fully', () => {
  const r = f.parseFubLeadEmail(
    'New Lead from Facebook - Rich Gholston',
    "Follow Up Boss You've received a new lead named Rich Gholston from Facebook RG (312) 502-4035 lamellgholston@gmail.com Are you working with a lender?: no User provided phone number: +13125024035 What is your time frame to buy?: 1-3_months"
  )
  assert.equal(r.kind, 'new')
  assert.equal(r.first, 'Rich'); assert.equal(r.last, 'Gholston')
  assert.equal(r.phone, '+13125024035')
  assert.equal(r.email, 'lamellgholston@gmail.com')
  assert.match(r.timeline, /1-3 months/)
  assert.match(r.timeline, /lender: no/)
})

test('ALERT (existing lead) Facebook email parses, price in subject handled', () => {
  const r = f.parseFubLeadEmail(
    'Lead Alert from Facebook - Steven Franklin - $499,000',
    'Follow Up Boss Lead alert for Steven Franklin from Facebook SF (319) 270-3089 steven72649@yahoo.com Are you working with a lender?: yes User provided phone number: +13192703089 What is your time frame to buy?: 1-3_months'
  )
  assert.equal(r.kind, 'alert')
  assert.equal(r.first, 'Steven'); assert.equal(r.last, 'Franklin')
  assert.equal(r.phone, '+13192703089')
  assert.match(r.timeline, /lender: yes/)
})

test('non-Facebook and digest emails are ignored', () => {
  assert.equal(f.parseFubLeadEmail('New Lead from Zillow - Kelley Mc - $334,900',
    "You've received a new lead named Kelley Mc from Zillow interested in 510 Broadway St, Springville, IA 52336 ($334900) KM (319) 480-8898 kelleymcn@gmail.com"), null)
  assert.equal(f.parseFubLeadEmail('Lead Alert for Brian Boss',
    'Follow Up Boss Lead alert for Brian Boss from cedarrapidshomeforsale (319) 390-8095 boss-brian@aramark.com'), null)
  assert.equal(f.parseFubLeadEmail('Follow Up Boss Hot Sheet: Thursday, September 17',
    'You have 2 appointments and 0 tasks happening today. Latest activity from Mark Herzberger.'), null)
})

test('handler is gated OFF by default and dedupes by Message-ID', async () => {
  db.setSetting('fub_lead_email_enabled', '0')
  // unique per run — the test DB persists, and the Message-ID dedupe is durable by design
  const uid = String(Date.now())
  const phone = freshPhone().e164
  const mail = { subject: 'New Lead from Facebook - Gate Check', text: `named Gate Check from Facebook User provided phone number: ${phone}`, messageId: `<gate1-${uid}@fub>` }
  assert.equal((await f.handleFubLeadEmail(mail)).skipped, 'disabled')
  db.setSetting('fub_lead_email_enabled', '1')
  try {
    const r1 = await f.handleFubLeadEmail(mail)
    assert.equal(r1.processed, 'new')
    assert.ok(r1.client_id)
    const r2 = await f.handleFubLeadEmail(mail)
    assert.equal(r2.skipped, 'already processed', 'same email never ingests twice')
    // existing person alert: notification path, no duplicate record
    const alert = { subject: 'Lead Alert from Facebook - Gate Check', text: `Lead alert for Gate Check from Facebook User provided phone number: ${phone}`, messageId: `<gate2-${uid}@fub>` }
    const r3 = await f.handleFubLeadEmail(alert)
    assert.equal(r3.matched_existing, true, 'alert matched the same person by phone')
    assert.equal(r3.client_id, r1.client_id)
  } finally { db.setSetting('fub_lead_email_enabled', '0') }
})

test('seller-campaign FB leads: seller type, seller tag, NO buyer automation', async () => {
  const { ingestFbLead } = await import('../server/lead-intake.js')
  const uniq = Date.now() + '' + Math.floor(Math.random() * 1e5)
  const r = ingestFbLead({ first: 'Selltest', last: 'Guard' + uniq, phone: freshPhone().pretty, listing: 'Fix It or Skip It Walkthrough' })
  const c = db.get('SELECT * FROM clients WHERE id=?', [r.client_id])
  assert.equal(c.type, 'seller')
  assert.ok(c.tags.includes('FB Seller Ad'))
  await new Promise(res => setTimeout(res, 300))   // async imports in intake settle
  assert.equal(db.get('SELECT COUNT(*) c FROM fb_listing_campaigns WHERE client_id=?', [r.client_id]).c, 0)
  assert.equal(db.get("SELECT COUNT(*) c FROM ai_scheduled_actions WHERE client_id=? AND action_type='AI_FB_AD_OPENER'", [r.client_id]).c, 0)
  db.run('DELETE FROM clients WHERE id=?', [r.client_id])
  db.run("DELETE FROM activity_log WHERE entity_type='client' AND entity_id=?", [r.client_id])
})
