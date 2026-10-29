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
//   3. sends the follow-up email
//   4. steps the Home Value campaign aside for 90 days, so nobody is emailed "check your
//      value" a week after they checked it
//
// Repeat submitters are the point. A second or third look is the strongest signal in this
// whole system, so each one is counted and logged rather than collapsed into the first.
import db from './database.js'
import { rule } from './rules.js'
import { inProactiveWindow, nextValidSlot } from './fsbo-followup.js'

const nowIso = () => new Date().toISOString()
// The canonical tag every requester carries, whichever door they came through. Its NAME is
// the retired seller site, which reads oddly now the tool has moved - but it is left
// exactly as it is on purpose: the Home Value Requested smart list matches it, and
// renaming it would orphan every historic requester (John, 2026-10-28).
export const HOME_VALUE_TAG = 'cedarrapidsmetroareahomevalue.sierrasellersites.com'
// WHICH door, tagged separately so the canonical tag never has to change. Keyed on the
// HV_Source line the native form writes, never on the page URL: the form posts through a
// hidden iframe on /contact/ and Sierra overwrites Sent_From from its own page context, so
// the URL says /contact/ for every submission.
export const HV_SOURCE_TAGS = {
  'mattsmithteam.com/home-value': 'Home Value: mattsmithteam.com/home-value',
}
export function sourceTagFor(sub) {
  const src = String(sub?.source_line || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  for (const [key, tag] of Object.entries(HV_SOURCE_TAGS)) {
    if (src === key || src.endsWith(key)) return tag
  }
  return null
}
const FOLLOWUP_TEMPLATE = 'Home Value Request — Follow-Up'
// Subjects that mean somebody submitted the form. IMAP SEARCH takes one term, so each
// is its own pass (see pollHomeValueSubmissions).
const NOTIFY_SUBJECTS = [
  'cedarrapidsmetroareahomevalue.sierrasellersites.com',   // the retiring seller site
  'Home Value Request',                                    // mattsmithteam.com/home-value
]

// The notification is a plain-text table of "Label: value" lines, with the interesting
// detail bundled into one free-text field as its own label: value list.
//
// TWO FIELD SCHEMES reach this function, and they share no field names (2026-10-28):
//
//   seller site (retiring)      native /home-value/ and /sellers/free-market-analysis/
//   *Name*                      First_Name + Last_Name
//   *Email Address*             Email
//   *Questions / Comments*      Questions
//
// Sierra wraps labels in asterisks in the notification mail and writes them bare in the
// stored note, so each label is read with the wrapper OPTIONAL. That matters because the
// field names were confirmed against the stored note while this function reads the mail.
//
// Getting this wrong is silent: field('Email Address') on a First_Name body returns '',
// handleHomeValueSubmission sees no email and skips, and the requester gets nothing at
// all. That is what the Free Market Analysis page has always done.
//
// Deliberately NOT keyed on Sent_From or the page URL: the native form posts through a
// hidden iframe on /contact/, so both point there rather than at /home-value/.
export function parseHomeValueEmail(text) {
  // The detail block opens on the SAME line as its label:
  //   "*Questions / Comments*: Address: 3720 Monarch Ave, Marion, IA 52302, USA"
  // so Address is not at the start of a line and a line-anchored match misses it.
  // Break the label off first and every field below reads uniformly. The native form's
  // block is `Questions`, and its answers are separated by <br/> rather than newlines.
  const t = String(text || '').replace(/\r/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*?\s*Questions(\s*\/\s*Comments)?\s*\*?\s*:\s*/i, '\n')
  // The asterisks are optional so one lookup reads the mail and the stored note alike.
  // Anchored on a line start so `Name` cannot match inside `First_Name`.
  const field = (label) => {
    const m = t.match(new RegExp('(?:^|\\n)\\s*\\*?\\s*' + label + '\\s*\\*?\\s*:[ \\t]*(.*)', 'i'))
    return m ? m[1].trim() : ''
  }
  const sub = (label) => {
    const m = t.match(new RegExp('^\\s*\\*?\\s*' + label + '\\s*\\*?\\s*:\\s*(.+)$', 'im'))
    return m ? m[1].trim() : ''
  }
  const money = (s) => { const n = Number(String(s || '').replace(/[^0-9.]/g, '')); return n > 0 ? Math.round(n) : null }

  // Most specific first: `Email Address` before `Email`, or the looser one wins on a
  // seller-site body and reads the wrong half of the label.
  const firstField = field('First_Name')
  const lastField = field('Last_Name')
  const name = (firstField || lastField)
    ? [firstField, lastField].filter(Boolean).join(' ')
    : field('Name')
  const [first, ...rest] = name.split(/\s+/).filter(Boolean)
  // HV_Address is the native form's own labelled field and is preferred over anything
  // sub-parsed out of the readable block: that block is written for Matt and John to read,
  // not to be parsed, and its wording is free to change.
  const addressLine = sub('HV_Address') || sub('Address')
  // "3720 Monarch Ave, Marion, IA 52302, USA" -> street / city / state / zip, and
  // "1625 RANMAR DR, ELY, IA, 52227" where the state and zip are separate parts.
  const parts = addressLine.split(',').map(s => s.trim()).filter(s => s && !/^usa$/i.test(s))
  const street = parts[0] || ''
  const city = parts[1] || ''
  const stZip = parts.slice(2).join(' ').match(/([A-Z]{2})\s*(\d{5})?/i)

  return {
    name, first_name: first || '', last_name: rest.join(' '),
    email: (field('Email Address') || field('Email')).toLowerCase(),
    phone: field('Phone'),
    // The native form sends no Request Type; it names itself on the first line of the
    // answer block instead.
    request_type: field('Request Type') || (/^\s*HOME VALUE REQUEST\s*$/im.test(t) ? 'Home Value Request' : ''),
    // Which door this came through. HV_Source is its own labelled field; the readable
    // block repeats it as a plain `Source:` line, so either will do. Nothing else emits
    // it - not the seller site, not the Free Market Analysis page - which makes it the one
    // reliable discriminator, unlike Sent_From or the page URL (both read /contact/,
    // because Sierra overwrites Sent_From from its own page context).
    source_line: sub('HV_Source') || sub('Source'),
    // Sierra merges on email, so a homeowner who asks twice lands on ONE lead and the two
    // submissions are otherwise indistinguishable. This is per-SUBMISSION, which is what
    // the dedupe key below really wants.
    submission_id: sub('HV_Submission_ID') || (addressLine && (t.match(/^\s*Reference:\s*(HV-[0-9]{8}-[A-Z0-9]{4})\s*$/im) || [])[1]) || '',
    // They answered condition on the form itself now. Captured so it is on the record and
    // in the alert; whether it should also pre-empt the Day 0 text that asks the same
    // question is John's call, and nothing here changes that sequence.
    condition: sub('HV_Condition'),
    would_buy: sub('HV_Would_Buy'),
    address: street, city, state: stZip ? stZip[1].toUpperCase() : '', zip: stZip && stZip[2] ? stZip[2] : '',
    address_full: addressLine,
    timeframe: sub('I am Planning to Move') || sub('Moving_When') || sub('HV_Timeline'),
    beds: sub('Beds') || sub('Bedrooms'), baths: sub('Baths') || sub('Bathrooms'),
    zillow_estimate: money(sub('Zillow Valuation Estimate')),
    avm_estimate: money(sub('AVM Estimate')),
    sierra_lead_id: (t.match(/lead-detail\.aspx\?id=(\d+)/) || [])[1] || null,
    // The notification states when the form was submitted, in the site's own words:
    //   "The following info was submitted from <site> at 10/27/2026 03:25 PM."
    // That string is the only timestamp that is IDENTICAL no matter which door the
    // notification comes through — IMAP internalDate and a webhook's arrival time differ
    // by seconds, and if they straddle a minute boundary the dedupe key differs and the
    // person gets emailed twice. Kept as the literal string: no timezone maths, nothing
    // to get wrong across DST.
    submitted_label: (t.match(/submitted from[\s\S]{0,200}?\bat\s+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}\s+[0-9]{1,2}:[0-9]{2}\s*[AP]M)/i) || [])[1] || '',
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

function addTag(client, ...add) {
  let tags = []
  try { const a = JSON.parse(client.tags || '[]'); if (Array.isArray(a)) tags = a.map(String) } catch {
    tags = String(client.tags || '').split(',').map(s => s.trim()).filter(Boolean)
  }
  for (const tag of add.filter(Boolean)) if (!tags.includes(tag)) tags.push(tag)
  return JSON.stringify(tags)
}

// Handle ONE submission. Idempotent on (email, submitted_at): the poller may see the same
// notification twice and must not email the person twice for it.
// recordOnly: log the submission and tag the lead, but send nothing and defer nothing.
// For seeding history from notifications that arrived before this existed — the 30-day
// "has already checked recently" rule needs those, and nobody should get an email today
// about a lookup they did three weeks ago.
export async function handleHomeValueSubmission(sub, { submittedAt = nowIso(), dryRun = false, recordOnly = false } = {}) {
  if (!sub || !sub.email) return { skipped: 'no email on the submission' }
  // Two doors now lead here: the IMAP poller and the webhook (routes/drips.js). They can
  // see the SAME notification seconds apart, so the dedupe key must not depend on which
  // one got there first. The form's own submitted-at string does not; arrival time does.
  // The native form stamps every submission with its own HV-YYYYMMDD-XXXX reference, which
  // is a better key than any timestamp: it is identical whichever door the notification
  // comes through, and it tells two submissions from the same person apart. The
  // submitted-at string stays as the key for the older format, which has no reference.
  const stableKey = sub.submission_id
    ? `hv_${sub.submission_id}`
    : (sub.submitted_label ? `hv_${sub.email}_${sub.submitted_label.replace(/\s+/g, ' ')}` : null)
  const legacyKey = `hv_${sub.email}_${String(submittedAt).slice(0, 16)}`
  // The legacy key is still checked so notifications processed before this change are not
  // re-sent when the poller's 2-day window sweeps over them again.
  for (const k of [stableKey, legacyKey].filter(Boolean)) {
    const seen = db.get("SELECT id FROM activity_log WHERE action='home_value_submission' AND details LIKE ?", ['%' + k + '%'])
    if (seen) return { skipped: 'already processed', key: k }
  }
  const key = stableKey || legacyKey

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
       JSON.stringify([HOME_VALUE_TAG, sourceTagFor(sub)].filter(Boolean)), nowIso().slice(0, 10), nowIso(), nowIso()])
    client = db.get('SELECT * FROM clients WHERE id = ?', [r.lastInsertRowid])
    created = true
  } else if (!dryRun) {
    // Hub owns contact data, so an existing address is never overwritten — only filled.
    const patch = { tags: addTag(client, HOME_VALUE_TAG, sourceTagFor(sub)) }
    if (!String(client.address || '').trim() && sub.address) Object.assign(patch, { address: sub.address, city: sub.city || null, state: sub.state || null, zip: sub.zip || null })
    if (!String(client.phone || '').trim() && sub.phone) patch.phone = sub.phone
    // A DIFFERENT number on the form is new information, not a correction. The Hub owns
    // contact data and must not overwrite a known-good number on the strength of one web
    // form — but throwing it away is worse: James Osullivan submitted (319) 321-0659 on
    // 2026-10-27 while the Hub held (319) 431-4988 from a Realist import, and any Day 0
    // text would have gone to the imported number. Keep both; let a person choose.
    else if (sub.phone) {
      const d10sub = d10(sub.phone)
      const known = new Set([client.phone, ...String(client.alt_phones || '').split(',')].map(d10).filter(s => s.length === 10))
      if (d10sub.length === 10 && !known.has(d10sub)) {
        patch.alt_phones = [String(client.alt_phones || '').trim(), sub.phone].filter(Boolean).join(', ')
        // alt_phone_labels is a JSON map keyed by the number, so this cannot misalign.
        try {
          const labels = JSON.parse(String(client.alt_phone_labels || '{}')) || {}
          labels[sub.phone] = 'Home value form'
          patch.alt_phone_labels = JSON.stringify(labels)
        } catch { /* a malformed existing map must not cost us the number itself */ }
      }
    }
    // ASKING WHAT YOUR HOME IS WORTH IS SELLER INTENT (John, 2026-10-28).
    //
    // A lead created BY this intake has always been typed seller. An existing one kept
    // whatever it arrived as, which is how ten homeowners ended up sitting on the Home
    // Value list typed `buyer` — mostly Realist imports, where the type says where the
    // record came from rather than what the person wants. `type` drives campaign routing
    // and the FUB stage mapping (prime + buyer lands in High Probability BUYERS), so the
    // wrong value is not cosmetic.
    //
    // Only `buyer` is switched. `both` already carries seller and flipping it would throw
    // the buyer half away, and `seller` is already right.
    if (String(client.type || '').trim().toLowerCase() === 'buyer') {
      patch.type = 'seller'
      try {
        db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
          ['type_changed', 'client', client.id, 'buyer -> seller: requested a home value'])
      } catch {}
    }
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
    // They rated condition on the form, so it belongs on the record rather than only in
    // the note Sierra holds.
    sub.condition && `condition: ${sub.condition}/10`,
    sub.would_buy && `would need to buy: ${sub.would_buy}`,
    sub.source_line && `via ${sub.source_line}`,
  ].filter(Boolean).join(' · ')
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
    ['home_value_submission', 'client', client.id, detail])

  if (recordOnly) return { client_id: client.id, created, visit: visitNo, recorded_only: true, detail }

  // Tell the team. The Sierra notification only reaches mattsmithremax@gmail.com, so a
  // submission could land, be matched and be answered without John ever seeing it — which
  // is exactly what happened with Nicole Morris on 2026-09-29 (John).
  //
  // The name someone types on the form is often not the name in the Hub: she submitted as
  // "Nicole Morris" and matched "Niki Morris" on the email. The alert says both, because
  // the mismatch is the thing that makes a person think they have a duplicate.
  await sendSubmissionAlert({ client, sub, created, visitNo }).catch(() => {})

  // Step the campaign aside for 90 days — a conversation now, emails later if nothing comes of it.
  let deferred = null
  try {
    const { deferOnHomeValueSubmission } = await import('./home-value-enroll.js')
    deferred = deferOnHomeValueSubmission(client.id)
  } catch (e) { console.error('[home-value] defer failed:', e.message) }

  // The follow-up. The video came out on 2026-09-29 while Matt re-records it; the
  // template is still found by name, so nothing here changes when it goes back in.
  let emailed = { ok: false, reason: 'not attempted' }
  try {
    const tpl = db.get('SELECT id, subject, body FROM templates WHERE name = ?', [FOLLOWUP_TEMPLATE])
    if (!tpl) emailed = { ok: false, reason: 'follow-up template missing' }
    else {
      const { sendSequenceEmail } = await import('./routes/email.js')
      emailed = await sendSequenceEmail(client, { template_id: tpl.id }, 'home_value_followup')
    }
  } catch (e) { emailed = { ok: false, reason: e.message } }

  // THE CONDITION QUESTION, two minutes behind the email (John, 2026-10-19).
  //
  // They have just asked what their home is worth, so they are at the keyboard and the
  // single most useful thing we can get back is condition: an online estimate cannot see a
  // remodelled kitchen or a roof that needs doing. A 1-to-10 answer is one tap to send.
  //
  // Only ever behind a SUCCESSFUL email. If the email did not go, this would be a text out
  // of nowhere thanking them for a request they would not see us answering.
  let questioned = { ok: false, reason: 'not attempted' }
  if (emailed?.ok) {
    try { questioned = scheduleConditionQuestion(client) }
    catch (e) { questioned = { ok: false, reason: e.message } }
  } else questioned = { ok: false, reason: 'email did not send, so no follow-up text' }

  // The 45 day follow-up picks up at Day 3. Behind the email for the same reason the Day 0
  // text is: without the email this is a sequence about a request they never saw answered.
  let sequence = { ok: false, reason: 'not attempted' }
  if (emailed?.ok) {
    try {
      const { enrollHvSms } = await import('./home-value-sms.js')
      sequence = enrollHvSms(client.id, { requestedAt: submittedAt, emailSentAt: nowIso(), day0At: questioned?.send_at || null })
    } catch (e) { sequence = { ok: false, reason: e.message } }
  } else sequence = { ok: false, reason: 'email did not send' }

  return { client_id: client.id, created, visit: visitNo, deferred, emailed, questioned, sequence, detail }
}

/** John's wording, verbatim. Straight apostrophes only: a curly one forces UCS-2 and cuts
 *  the segment from 160 characters to 70. */
// Day 0, two minutes behind the valuation email. John's wording, approved 2026-10-19 and
// LEFT ALONE since.
//
// Condition is asked FIRST because it is the single thing an automated valuation cannot
// see, and it is a one-tap answer. Nothing about selling is asked here, or anywhere until
// Day 15; the rest of the sequence earns that question before raising it.
//
// The 2026-10-23 response-campaign spec restated this text slightly differently and without
// the website link. It was briefly changed to match, and John reverted it the same day:
// "don't touch what we've already built last time, this is just additional text and
// emails". So the Day 0 message is the Oct 19 one, URL included, and everything in the new
// spec is additional to it.
export const CONDITION_QUESTION =
  "Hi {{first_name}}, this is John with Matt Smith Team at RE/MAX. Thanks for requesting a home value estimate for {{street_address}}! To help us narrow down the value, I have a quick question. On a scale of 1 to 10, how would you rate your home's overall condition? 1 being it needs a complete renovation and 10 being in model-home condition. https://www.mattsmithteam.com/"

/**
 * Queue the condition question. Returns without scheduling rather than throwing, because a
 * missing phone is the normal case for a web form, not an error.
 *
 * TIMING. Two minutes, unless that lands in quiet hours, in which case it waits for the
 * morning. Deliberately NOT pushed to the next weekday 9-to-5 slot the way proactive
 * prospecting is: this is a reply to something they did themselves minutes ago, and holding
 * a Saturday enquiry until Monday throws away the reason for sending it. Quiet hours are
 * the boundary that matters here, not the working week.
 */
export function scheduleConditionQuestion(client) {
  const cid = Number(client?.id)
  if (!cid) return { ok: false, reason: 'no client' }
  const phone = String(client.phone || '').replace(/\D/g, '')
  if (phone.length < 10) return { ok: false, reason: 'no mobile number on file' }
  // Hard compliance now; the runner re-checks it again at send time.
  if (client.hub_text_opt_out) return { ok: false, reason: 'replied STOP to our number' }
  if (client.sms_undeliverable) return { ok: false, reason: 'number is undeliverable' }

  // One per person, ever. A second or third home value request is a strong signal and gets
  // a person, not the same canned question again.
  // "One per person, ever" has to mean one they ACTUALLY RECEIVED, or one still on its
  // way. This used to match any row in any state, so a question that was canceled or
  // failed — never seen by the lead — silently blocked the real one forever, and the
  // block was invisible: scheduleConditionQuestion's {ok:false} is returned into a value
  // nobody reads. James Osullivan asked for a CMA on 2026-10-27, had never been sent a
  // single text in 14 messages of history, and still got no Day 0 question.
  const asked = db.get(
    `SELECT id FROM scheduled_texts WHERE client_id=? AND body LIKE '%overall condition%'
       AND status IN ('sent','scheduled') LIMIT 1`, [cid])
  if (asked) return { ok: false, reason: 'already asked this lead' }

  const mins = (() => { try { return rule('home_value_question_delay_minutes') } catch { return 2 } })()
  // Two minutes, but inside the permitted SMS window. John's spec, 2026-10-19: "the
  // existing Day 0 two-minute delay must also respect permitted sending hours. If the
  // email is sent outside the SMS window, queue the text for the next permitted time."
  // This replaces the quiet-hours-only rule I shipped earlier the same day.
  let at = new Date(Date.now() + mins * 60000)
  if (!inProactiveWindow(at)) at = nextValidSlot(at)

  const r = db.run(`INSERT INTO scheduled_texts (client_id, phone, body, send_at, status, created_by, created_at)
                    VALUES (?,?,?,?,'scheduled','home_value_intake',?)`,
    [cid, client.phone, CONDITION_QUESTION, at.toISOString(), nowIso()])
  return { ok: true, id: r.lastInsertRowid, send_at: at.toISOString(), delayed_for_quiet_hours: at.getTime() > Date.now() + (mins + 1) * 60000 }
}

/** If `d` falls inside quiet hours, move it to the morning they end. */
export function pushOutOfQuietHours(d) {
  const hourIn = (dt) => {
    try {
      return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).formatToParts(dt).find(p => p.type === 'hour')?.value)
    } catch { return dt.getHours() }
  }
  const startH = Number(String(db.getSetting?.('ai_quiet_hours_start', '21:00')).split(':')[0]) || 21
  const endH = Number(String(db.getSetting?.('ai_quiet_hours_end', '08:00')).split(':')[0]) || 8
  let out = new Date(d)
  for (let i = 0; i < 48; i++) {
    const h = hourIn(out)
    const quiet = startH > endH ? (h >= startH || h < endH) : (h >= startH && h < endH)
    if (!quiet) return out
    out = new Date(out.getTime() + 30 * 60000)   // creep forward until the window opens
  }
  return out
}

// Poll Matt's mailboxes for new notifications and process them.
const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

// One internal alert per submission. Deduped through activity_log the same way the FB lead
// alert is, so a re-poll of the same mailbox cannot alert twice for one form.
async function sendSubmissionAlert({ client, sub, created, visitNo }) {
  const dedupe = `[hv_alert:${client.id}:${visitNo}]`
  if (db.get("SELECT id FROM activity_log WHERE details LIKE ? AND created_at >= datetime('now','-7 days')", ['%' + dedupe + '%'])) return
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
    ['home_value_alert', 'client', client.id, `Home value alert emailed ${dedupe}`])

  const { sendViaSendGrid } = await import('./routes/email.js')
  const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  const hubName = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  const formName = sub.name || ''
  const different = formName && hubName && formName.toLowerCase() !== hubName.toLowerCase()

  const subject = created
    ? `Home value request: ${formName} (new lead)`
    : `Home value request: ${formName}${different ? ` — matched ${hubName}` : ''}${visitNo > 1 ? ` — visit #${visitNo}` : ''}`

  const rows = [
    different && ['Heads up', `Submitted as "${formName}", matched the existing record for "${hubName}" on the email address — not a duplicate`],
    created && ['Status', 'Brand new lead, created in the Hub'],
    visitNo > 1 && ['Repeat', `This is look-up #${visitNo} for them`],
    ['Address', sub.address_full || sub.address || '—'],
    ['Email', sub.email || '—'],
    ['Phone', sub.phone || '—'],
    ['Timeframe', sub.timeframe || '—'],
    (sub.beds || sub.baths) && ['Home', `${sub.beds || '?'} bed / ${sub.baths || '?'} bath`],
    sub.zillow_estimate && ['Zillow', '$' + Number(sub.zillow_estimate).toLocaleString()],
    sub.avm_estimate && ['AVM', '$' + Number(sub.avm_estimate).toLocaleString()],
  ].filter(Boolean).map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${esc(k)}</td>` +
    `<td style="padding:4px 0;color:#0f172a;"><strong>${esc(v)}</strong></td></tr>`).join('')

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
    <p style="margin:0 0 6px;font-size:16px;"><strong>${esc(formName)}</strong> requested a home value.</p>
    <table style="border-collapse:collapse;margin:8px 0 14px;">${rows}</table>
    <p style="margin:0 0 12px;"><a href="${hub}/clients/${client.id}" style="display:inline-block;background:#B9963B;color:#241a04;font-weight:700;padding:10px 18px;border-radius:8px;text-decoration:none;">View Lead</a></p>
    <p style="margin:0;color:#64748b;font-size:12px;">Matt Smith Team Hub · home value request alert · the follow-up email has been sent to them automatically</p></div>`

  await sendViaSendGrid('johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com',
    'Matt Smith Team', subject, html, null, [], [], [], 'home_value_alert')
}

export async function pollHomeValueSubmissions({ sinceDays = 3, max = 25, dryRun = false, recordOnly = false } = {}) {
  const { searchMailboxesBySubject } = await import('./gmail-inbox.js')
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10)
  let searched = 0
  const messages = [], seen = new Set()
  for (const subject of NOTIFY_SUBJECTS) {
    const found = await searchMailboxesBySubject(subject, { max, since })
    searched += found.count || 0
    for (const m of (found.messages || [])) {
      const key = m.mailbox + '|' + m.date
      if (seen.has(key)) continue
      seen.add(key); messages.push(m)
    }
  }
  const results = []
  for (const m of messages) {
    const sub = parseHomeValueEmail(m.body)
    if (!sub.email) { results.push({ date: m.date, skipped: 'could not parse an email address' }); continue }
    const r = await handleHomeValueSubmission(sub, { submittedAt: m.date, dryRun, recordOnly })
    results.push({ date: m.date, name: sub.name, ...r })
  }
  return { searched, processed: results.length, results }
}
