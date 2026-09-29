// Home value form submissions, read straight off the notification email.
//
// Why the email and not the tag: Sierra emails Matt within seconds of a submission and the
// message carries everything — name, email, phone, the address they looked up, their
// timeframe, beds, baths, and both the Zillow and AVM estimates. Waiting for the lead to
// appear in the Hub through Sierra does not work: the two submissions on 2026-09-28 were in
// Gmail and in Sierra within seconds and still had not reached the Hub hours later. This is
// the same pattern the FB ad pipeline already uses.
//
// One submission does four things:
//   1. finds or creates the Hub lead, and tags it
//   2. records the estimates and what they told the form
//   3. sends the follow-up email with the Loom
//   4. steps the Home Value campaign aside for 90 days, so nobody is emailed "check your
//      value" a week after they checked it
//
// Repeat submitters are the point. A second or third look is the strongest signal in this
// whole system, so each one is counted and logged rather than collapsed into the first.
import db from './database.js'

const nowIso = () => new Date().toISOString()
export const HOME_VALUE_TAG = 'cedarrapidsmetroareahomevalue.sierrasellersites.com'
const FOLLOWUP_TEMPLATE = 'Home Value Request — Follow-Up'
const NOTIFY_SUBJECT = 'cedarrapidsmetroareahomevalue.sierrasellersites.com'

// The notification is a plain-text table of "*Label*: value" lines, with the interesting
// detail bundled into Questions / Comments as its own label: value list.
export function parseHomeValueEmail(text) {
  // The detail block opens on the SAME line as its label:
  //   "*Questions / Comments*: Address: 3720 Monarch Ave, Marion, IA 52302, USA"
  // so Address is not at the start of a line and a line-anchored match misses it.
  // Break the label off first and every field below reads uniformly.
  const t = String(text || '').replace(/\r/g, '')
    .replace(/\*\s*Questions\s*\/\s*Comments\s*\*\s*:\s*/i, '\n')
  const field = (label) => {
    const m = t.match(new RegExp('\\*\\s*' + label + '\\s*\\*\\s*:\\s*(.+)', 'i'))
    return m ? m[1].trim() : ''
  }
  const sub = (label) => {
    const m = t.match(new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'im'))
    return m ? m[1].trim() : ''
  }
  const money = (s) => { const n = Number(String(s || '').replace(/[^0-9.]/g, '')); return n > 0 ? Math.round(n) : null }

  const name = field('Name')
  const [first, ...rest] = name.split(/\s+/).filter(Boolean)
  const addressLine = sub('Address')
  // "3720 Monarch Ave, Marion, IA 52302, USA" -> street / city / state / zip
  const parts = addressLine.split(',').map(s => s.trim()).filter(s => s && !/^usa$/i.test(s))
  const street = parts[0] || ''
  const city = parts[1] || ''
  const stZip = (parts[2] || '').match(/([A-Z]{2})\s*(\d{5})?/i)

  return {
    name, first_name: first || '', last_name: rest.join(' '),
    email: field('Email Address').toLowerCase(),
    phone: field('Phone'),
    request_type: field('Request Type'),
    address: street, city, state: stZip ? stZip[1].toUpperCase() : '', zip: stZip && stZip[2] ? stZip[2] : '',
    address_full: addressLine,
    timeframe: sub('I am Planning to Move'),
    beds: sub('Beds'), baths: sub('Baths'),
    zillow_estimate: money(sub('Zillow Valuation Estimate')),
    avm_estimate: money(sub('AVM Estimate')),
    sierra_lead_id: (t.match(/lead-detail\.aspx\?id=(\d+)/) || [])[1] || null,
  }
}

const d10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)

// Find the lead this submission belongs to: email first, then a 10-digit phone match.
// Never creates a duplicate of somebody already in the file.
function findLead(sub) {
  if (sub.email) {
    const byEmail = db.get('SELECT * FROM clients WHERE merged_into IS NULL AND lower(email) = lower(?) LIMIT 1', [sub.email])
    if (byEmail) return byEmail
  }
  const p = d10(sub.phone)
  if (p.length === 10) {
    const cands = db.all("SELECT * FROM clients WHERE merged_into IS NULL AND phone LIKE ?", ['%' + p.slice(-4)])
    const hit = cands.find(c => d10(c.phone) === p)
    if (hit) return hit
  }
  return null
}

function addTag(client, tag) {
  let tags = []
  try { const a = JSON.parse(client.tags || '[]'); if (Array.isArray(a)) tags = a.map(String) } catch {
    tags = String(client.tags || '').split(',').map(s => s.trim()).filter(Boolean)
  }
  if (!tags.includes(tag)) tags.push(tag)
  return JSON.stringify(tags)
}

// Handle ONE submission. Idempotent on (email, submitted_at): the poller may see the same
// notification twice and must not email the person twice for it.
export async function handleHomeValueSubmission(sub, { submittedAt = nowIso(), dryRun = false } = {}) {
  if (!sub || !sub.email) return { skipped: 'no email on the submission' }
  const key = `hv_${sub.email}_${String(submittedAt).slice(0, 16)}`
  const seen = db.get("SELECT id FROM activity_log WHERE action='home_value_submission' AND details LIKE ?", ['%' + key + '%'])
  if (seen) return { skipped: 'already processed', key }

  let client = findLead(sub)
  let created = false
  if (!client) {
    if (dryRun) return { would_create: sub.name, email: sub.email, address: sub.address }
    const r = db.run(
      `INSERT INTO clients (first_name, last_name, email, phone, type, status, source, agent_assigned,
        address, city, state, zip, tags, register_date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sub.first_name, sub.last_name, sub.email, sub.phone || null, 'seller', 'new',
       'Home Value Site', 'Matt Smith', sub.address || null, sub.city || null, sub.state || null, sub.zip || null,
       JSON.stringify([HOME_VALUE_TAG]), nowIso().slice(0, 10), nowIso(), nowIso()])
    client = db.get('SELECT * FROM clients WHERE id = ?', [r.lastInsertRowid])
    created = true
  } else if (!dryRun) {
    // Hub owns contact data, so an existing address is never overwritten — only filled.
    const patch = { tags: addTag(client, HOME_VALUE_TAG) }
    if (!String(client.address || '').trim() && sub.address) Object.assign(patch, { address: sub.address, city: sub.city || null, state: sub.state || null, zip: sub.zip || null })
    if (!String(client.phone || '').trim() && sub.phone) patch.phone = sub.phone
    const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ')
    db.run(`UPDATE clients SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), nowIso(), client.id])
    client = db.get('SELECT * FROM clients WHERE id = ?', [client.id])
  }
  if (dryRun) return { matched: client?.id, created, sub }

  // How many times have they now looked? The repeat is the signal worth acting on.
  const priorCount = db.get("SELECT COUNT(*) c FROM activity_log WHERE action='home_value_submission' AND entity_id=?", [client.id]).c
  const visitNo = priorCount + 1

  const detail = [
    `${key} | visit #${visitNo}`,
    sub.address_full && `looked up: ${sub.address_full}`,
    sub.timeframe && `planning to move: ${sub.timeframe}`,
    (sub.beds || sub.baths) && `${sub.beds || '?'} bed / ${sub.baths || '?'} bath`,
    sub.zillow_estimate && `Zillow $${sub.zillow_estimate.toLocaleString()}`,
    sub.avm_estimate && `AVM $${sub.avm_estimate.toLocaleString()}`,
    sub.request_type && `request: ${sub.request_type}`,
  ].filter(Boolean).join(' · ')
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
    ['home_value_submission', 'client', client.id, detail])

  // Step the campaign aside for 90 days — a conversation now, emails later if nothing comes of it.
  let deferred = null
  try {
    const { deferOnHomeValueSubmission } = await import('./home-value-enroll.js')
    deferred = deferOnHomeValueSubmission(client.id)
  } catch (e) { console.error('[home-value] defer failed:', e.message) }

  // The follow-up with the Loom.
  let emailed = { ok: false, reason: 'not attempted' }
  try {
    const tpl = db.get('SELECT id, subject, body FROM templates WHERE name = ?', [FOLLOWUP_TEMPLATE])
    if (!tpl) emailed = { ok: false, reason: 'follow-up template missing' }
    else {
      const { sendSequenceEmail } = await import('./routes/email.js')
      emailed = await sendSequenceEmail(client, { template_id: tpl.id }, 'home_value_followup')
    }
  } catch (e) { emailed = { ok: false, reason: e.message } }

  return { client_id: client.id, created, visit: visitNo, deferred, emailed, detail }
}

// Poll Matt's mailboxes for new notifications and process them.
export async function pollHomeValueSubmissions({ sinceDays = 3, max = 25, dryRun = false } = {}) {
  const { searchMailboxesBySubject } = await import('./gmail-inbox.js')
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10)
  const found = await searchMailboxesBySubject(NOTIFY_SUBJECT, { max, since })
  const results = []
  for (const m of (found.messages || [])) {
    const sub = parseHomeValueEmail(m.body)
    if (!sub.email) { results.push({ date: m.date, skipped: 'could not parse an email address' }); continue }
    const r = await handleHomeValueSubmission(sub, { submittedAt: m.date, dryRun })
    results.push({ date: m.date, name: sub.name, ...r })
  }
  return { searched: found.count || 0, processed: results.length, results }
}
