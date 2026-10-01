// Which lead sources the FUB watcher accepts, and what each one is allowed to trigger.
//
// The watcher was Facebook-only, which is why Dawn Moore was missed: her 510 Broadway
// inquiry arrived as source "Zillow" and the gate rejected it. John asked for Zillow,
// Realtor.com and Homes.com as well (2026-10-01).
//
// The source names asserted here are the REAL ones from the Hub's own list, not invented:
// "Zillow", "FSBO Zillow", "Realtor", "Realtor.com", "Homes.com".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { parseFubLeadEmail, matchWatchedSource, portalLabel, isFacebookPortal,
        watchedSources, DEFAULT_WATCH_SOURCES } = await import('../server/fub-leads.js')

// ── the gate ─────────────────────────────────────────────────────────────────────────
test('the portals John asked for are watched', () => {
  for (const src of ['Zillow', 'FSBO Zillow', 'Realtor', 'Realtor.com', 'Homes.com',
                     'Facebook', 'Instagram Lead Ads'])
    assert.ok(matchWatchedSource(src), `${src} should be watched`)
})

// These already reach the Hub through the Sierra sync. Watching them here would mean a
// second notification and duplicate outreach to people the team is already working.
test('the website and Sierra are NOT watched, so there is no double outreach', () => {
  for (const src of ['mattsmithteam.com', 'Mattsmithteam.com', 'Sierra Interactive',
                     'Tags synced via Sierra/FUB integration', 'Chime Listing Ads'])
    assert.equal(matchWatchedSource(src), '', `${src} must not be watched`)
})

test('a lookalike source name does not sneak through', () => {
  // "Boost By Homespotter.com" contains "homes" but is not homes.com
  assert.equal(matchWatchedSource('Boost By Homespotter.com'), '')
  assert.equal(matchWatchedSource('The Land.com Network'), '')
  assert.equal(matchWatchedSource(''), '')
  assert.equal(matchWatchedSource(null), '')
})

test('the list is a setting, so a portal can be added without a deploy', () => {
  assert.match(DEFAULT_WATCH_SOURCES, /zillow/)
  const before = watchedSources()
  db.setSetting('lead_watch_sources', 'trulia')
  try {
    assert.deepEqual(watchedSources(), ['trulia'])
    assert.ok(matchWatchedSource('Trulia'))
    assert.equal(matchWatchedSource('Zillow'), '', 'the setting replaces the default')
  } finally { db.setSetting('lead_watch_sources', DEFAULT_WATCH_SOURCES) }
  assert.deepEqual(watchedSources(), before)
})

// ── labelling ────────────────────────────────────────────────────────────────────────
test('each source gets a presentable portal name', () => {
  assert.equal(portalLabel('Zillow'), 'Zillow')
  assert.equal(portalLabel('FSBO Zillow'), 'Zillow')
  assert.equal(portalLabel('Realtor.com'), 'Realtor.com')
  assert.equal(portalLabel('Realtor'), 'Realtor.com')
  assert.equal(portalLabel('Homes.com'), 'Homes.com')
  assert.equal(portalLabel('Facebook'), 'Facebook')
  assert.equal(portalLabel('Instagram Lead Ads'), 'Instagram')
})

// This is the distinction the automation hangs off, so it is asserted directly.
test('only Facebook and Instagram count as Facebook', () => {
  assert.ok(isFacebookPortal('Facebook'))
  assert.ok(isFacebookPortal('Instagram'))
  for (const p of ['Zillow', 'Realtor.com', 'Homes.com'])
    assert.ok(!isFacebookPortal(p), `${p} must not be treated as Facebook`)
})

// ── the email trigger, which is the path actually running ────────────────────────────
const body = 'User provided phone number: (319) 310-6464'

test('a Zillow notification is now ingested — this is the Dawn Moore case', () => {
  const r = parseFubLeadEmail('New Lead from Zillow - Dawn Moore', body)
  assert.ok(r, 'it must no longer be rejected')
  assert.equal(r.portal, 'Zillow')
  assert.equal(r.kind, 'new')
  assert.equal(r.first, 'Dawn')
  assert.equal(r.last, 'Moore')
  assert.equal(r.phone, '(319) 310-6464')
})

test('Realtor.com and Homes.com are ingested too', () => {
  assert.equal(parseFubLeadEmail('New Lead from Realtor.com - Greg Ervin', body)?.portal, 'Realtor.com')
  assert.equal(parseFubLeadEmail('New Lead from Homes.com - Greg Ervin', body)?.portal, 'Homes.com')
})

test('Facebook still works, and still reports as Facebook', () => {
  const r = parseFubLeadEmail('New Lead from Facebook - Rich Gholston', body)
  assert.equal(r?.portal, 'Facebook')
  assert.equal(r?.kind, 'new')
})

test('a price in the subject does not become the name', () => {
  // real subject shape: "Lead Alert from Zillow - Steven Franklin - $499,000"
  const r = parseFubLeadEmail('Lead Alert from Zillow - Steven Franklin - $499,000', body)
  assert.equal(r?.kind, 'alert')
  assert.equal(r?.first, 'Steven')
  assert.equal(r?.last, 'Franklin')
})

test('an unwatched source is still rejected', () => {
  for (const subj of ['New Lead from Mattsmithteam.com - Someone',
                      'New Lead from Sierra Interactive - Someone',
                      'Hot Sheet Digest',
                      'Property Inquiry - Dawn Moore'])
    assert.equal(parseFubLeadEmail(subj, body), null, `"${subj}" should be rejected`)
})

test('a watched source still needs a lead-ish subject', () => {
  // a Zillow saved-search digest is not a lead
  assert.equal(parseFubLeadEmail('Your Zillow weekly report', body), null)
})

// ── what each portal is allowed to TRIGGER ────────────────────────────────────────────
// The whole point of keeping the portal separate: John's opener bank (fb-ad-templates.js)
// is written for Facebook ads and references the ad itself. Sending that to someone who
// enquired on Zillow would read wrong, and there is no approved portal copy yet.
const { ingestFbLead } = await import('../server/lead-intake.js')

// a number nobody is using - the dev DB holds thousands of (319) 555-xxxx fixtures
function freshPhone() {
  for (let i = 0; i < 200; i++) {
    const exch = 200 + Math.floor(Math.random() * 700)
    const line = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
    const taken = db.get(
      "SELECT 1 FROM clients WHERE replace(replace(replace(replace(COALESCE(phone,''),'(',''),')',''),'-',''),' ','') LIKE ?",
      ['%' + exch + line])
    if (!taken) return `(319) ${exch}-${line}`
  }
  throw new Error('no unused phone')
}

const settle = () => new Promise(r => setTimeout(r, 400))   // intake fires async imports

const ingest = async (portal, listing = '510 Broadway St') => {
  const uniq = Math.random().toString(36).slice(2, 8)
  const r = ingestFbLead({ first: 'Portal', last: 'T' + uniq, phone: freshPhone(), listing, portal })
  await settle()
  const c = db.get('SELECT * FROM clients WHERE id = ?', [r.client_id])
  const opener = db.get("SELECT COUNT(*) n FROM ai_scheduled_actions WHERE client_id=? AND action_type='AI_FB_AD_OPENER'", [r.client_id]).n
  const campaign = db.get('SELECT COUNT(*) n FROM fb_listing_campaigns WHERE client_id=?', [r.client_id]).n
  return { id: r.client_id, c, opener, campaign }
}

test('a Zillow lead is tagged and sourced as Zillow, not Facebook', async () => {
  const { c } = await ingest('Zillow')
  assert.equal(c.source, 'Zillow')
  assert.match(c.tags, /Zillow Lead/)
  assert.ok(!/FB Ad/.test(c.tags), 'it must not be tagged as a Facebook ad lead')
  assert.match(String(c.notes), /Zillow inquiry/)
  assert.ok(!/Facebook listing ad/.test(String(c.notes)), 'the note must not say Facebook')
})

test('a portal lead gets NO Facebook opener and NO Facebook campaign', async () => {
  for (const portal of ['Zillow', 'Realtor.com', 'Homes.com']) {
    const { opener, campaign } = await ingest(portal)
    assert.equal(opener, 0, `${portal} must not get the Facebook ad opener`)
    assert.equal(campaign, 0, `${portal} must not enter the 30-day Facebook listing campaign`)
  }
})

test('a Facebook lead still behaves exactly as before', async () => {
  const { c } = await ingest('Facebook')
  assert.equal(c.source, 'Facebook Listing Ad')
  assert.match(c.tags, /FB Ad/)
  assert.match(String(c.notes), /Facebook listing ad lead/)
})

test('the portal default stays Facebook, so existing callers are unaffected', async () => {
  const uniq = Math.random().toString(36).slice(2, 8)
  const r = ingestFbLead({ first: 'Default', last: 'T' + uniq, phone: freshPhone(), listing: 'x' })
  await settle()
  const c = db.get('SELECT * FROM clients WHERE id = ?', [r.client_id])
  assert.equal(c.source, 'Facebook Listing Ad')
  assert.match(c.tags, /FB Ad/)
})

test('a portal seller inquiry is typed seller but skips the Meta campaign', async () => {
  const { c, id } = await ingest('Zillow', 'Fix It or Skip It Walkthrough')
  assert.equal(c.type, 'seller', 'it is still a seller')
  // the Fix It or Skip It family is a Meta campaign; a Zillow lead must not enter it
  const enrolled = db.get("SELECT COUNT(*) n FROM drip_enrollments WHERE client_id=?", [id]).n
  assert.equal(enrolled, 0, 'no Meta seller campaign enrolment for a portal lead')
})
