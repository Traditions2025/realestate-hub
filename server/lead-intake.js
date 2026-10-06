// Shared Facebook-ad lead intake. One function ingests a lead no matter how it
// arrived (FUB event watcher, the direct fb-webhook, a manual backfill):
// dedupe by phone then email, tag to the listing/campaign, save the timeline
// answer, notify the team, claim any unknown call/text history, and hand the
// lead to the AI fresh lane for the ~5-minute first text.
import db from './database.js'
import { prependNote as prependClientNote } from './client-notes.js'

const nowIso = () => new Date().toISOString()
function logActivity(action, entityType, entityId, details) {
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', [action, entityType, entityId, details]) } catch {}
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
async function sendFbLeadAlertEmail({ cid, name, phone, email, listing, timeline, existing, seller = false, portal = 'Facebook' }) {
  try {
    // ONE alert per lead per campaign per 3 days — no matter how many paths
    // (email sweep, webhook, manual trigger, backfill) touch the same person
    // (John, 2026-09-17: duplicate alerts after the backfill re-read emails).
    const fromFb = /facebook|instagram/i.test(String(portal))
    const dedupe = `[fb_alert:${cid}:${String(listing || '').slice(0, 40)}]`
    if (db.get("SELECT id FROM activity_log WHERE details LIKE ? AND created_at >= datetime('now','-3 days')", ['%' + dedupe + '%'])) return
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['fb_lead_alert', 'client', cid, `${portal} lead alert emailed ${dedupe}`])
    const { sendViaSendGrid } = await import('./routes/email.js')
    const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const who = name || phone || email || 'Unknown'
    const label = fromFb ? 'Facebook Ad Lead' : `${portal} Lead`
    const subject = existing
      ? `${label} (EXISTING): ${who}${listing ? ' — ' + listing : ''}`
      : `New ${label}: ${who}${listing ? ' — ' + listing : ''}`
    const rows = [
      existing
        ? ['Heads up', fromFb ? 'This is an EXISTING lead in the Hub who just registered on the ad'
                              : `This is an EXISTING lead in the Hub who just enquired on ${portal}`]
        : ['Status', !fromFb ? `${portal} lead — no automated text; the opener bank is written for Facebook ads, so reach out personally`
                   : seller ? 'Seller campaign lead — no automated texts; reach out personally'
                            : 'Brand new lead — created in the Hub, AI first text on the way'],
      ['Listing', listing || '—'], ['Phone', phone || '—'], ['Email', email || '—'], ['Timeline', timeline || '—'],
    ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;">${esc(k)}</td><td style="padding:4px 0;color:#0f172a;"><strong>${esc(v)}</strong></td></tr>`).join('')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
      <p style="margin:0 0 6px;font-size:16px;"><strong>${esc(who)}</strong> ${existing ? 're-registered on' : 'came in from'} ${fromFb ? 'your Facebook listing ad' : esc(portal)}.</p>
      <table style="border-collapse:collapse;margin:8px 0 14px;">${rows}</table>
      <p style="margin:0 0 12px;"><a href="${hub}/clients/${cid}" style="display:inline-block;background:#B9963B;color:#241a04;font-weight:700;padding:10px 18px;border-radius:8px;text-decoration:none;">View Lead</a></p>
      <p style="margin:0;color:#64748b;font-size:12px;">Matt Smith Team Hub · ${esc(fromFb ? 'Facebook ad' : portal)} lead alert</p></div>`
    await sendViaSendGrid('johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com', 'Matt Smith Team', subject, html, null, [], [], [], 'fb_lead_alert')
  } catch (e) { try { console.error('[fb-lead-alert-email]', e.message) } catch {} }
}

export function ingestFbLead({ first = '', last = '', email = null, phone = null, timeline = '', listing = '', marker = '', source = null, raw = '', portal = 'Facebook' } = {}) {
  // WHICH PORTAL THIS CAME FROM (John, 2026-10-01).
  //
  // The watcher used to accept Facebook only. It now also takes Zillow, Realtor.com and
  // Homes.com, and those leads must NOT be dressed up as Facebook ad fills:
  //
  //   - the tag and the note name the real portal, so the record is not misattributed
  //   - NO automated opener. John's bank (fb-ad-templates.js) is written for Facebook ads
  //     and references the ad itself, which would read wrong to someone who enquired on
  //     Zillow. There is no approved portal copy yet, so a portal lead gets the record,
  //     the tag, the note, the notification and the alert email, and a person decides.
  //   - no 30-day Facebook listing campaign, same reason
  const fromFacebook = /facebook|instagram/i.test(String(portal || ''))
  const portalName = String(portal || '').trim() || 'Facebook'
  if (!source) source = fromFacebook ? 'Facebook Listing Ad' : portalName
  // SELLER campaigns (Fix It or Skip It etc., John 2026-09-18): these leads are
  // homeowners, not buyers — the buyer listing opener and the 30-day listing
  // campaign would send them the WRONG message. Seller ad leads get tagged,
  // typed 'seller', and the team is notified; no automated buyer texts.
  const isSellerCampaign = /fix.?it.?or.?skip|walkthrough|seller|home.?value|cma|list(?:ing)? your/i.test(String(listing))
  const d10 = String(phone || '').replace(/\D/g, '').slice(-10)
  const phoneFmt = d10.length === 10 ? `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}` : null
  const cleanEmail = String(email || '').trim() || null
  // dedupe: phone (last-10) first, then email
  let existing = null
  if (d10.length === 10) {
    existing = db.all("SELECT id, first_name, last_name, phone, alt_phones, email, tags FROM clients WHERE merged_into IS NULL AND (phone LIKE ? OR alt_phones LIKE ?)", ['%' + d10.slice(-4), '%' + d10.slice(-4) + '%'])
      .find(c => [c.phone, ...String(c.alt_phones || '').split(',')].some(p => String(p || '').replace(/\D/g, '').slice(-10) === d10))
  }
  if (!existing && cleanEmail) existing = db.get('SELECT id, first_name, last_name, email, tags FROM clients WHERE lower(email)=lower(?) AND merged_into IS NULL', [cleanEmail])
  const now = nowIso()
  const tagBase = fromFacebook ? (isSellerCampaign ? 'FB Seller Ad' : 'FB Ad') : `${portalName} Lead`
  const tag = tagBase + (listing ? ': ' + String(listing).slice(0, 60) : '')
  const what = fromFacebook ? 'Facebook listing ad lead' : `${portalName} inquiry`
  const noteLine = `${what}${listing ? ` (${listing})` : ''}${timeline ? ` — timeline: ${timeline}` : ''}${marker ? ' ' + marker : ''}`
  let cid
  if (existing) {
    cid = existing.id
    let tags = []; try { tags = JSON.parse(existing.tags || '[]') } catch {}
    if (!tags.includes(tag)) tags.push(tag)
    // This used to APPEND, so an intake note landed at the bottom of a profile while
    // every other writer prepends — a brand new lead's note read as the oldest thing on
    // the file. Same helper as the rest now, newest first (John, 2026-10-05).
    const priorNotes = db.get('SELECT notes FROM clients WHERE id=?', [cid])?.notes || ''
    db.run(`UPDATE clients SET tags=?, email=COALESCE(email, ?), phone=COALESCE(NULLIF(phone,''), ?),
            agent_assigned=COALESCE(NULLIF(agent_assigned,''), 'Matt Smith'),
            register_date=COALESCE(NULLIF(register_date,''), ?),
            notes=?, updated_at=? WHERE id=?`,
      [JSON.stringify(tags), cleanEmail, phoneFmt, now.slice(0, 10),
       prependClientNote(priorNotes, noteLine, { by: portalName || 'intake' }), now, cid])
    logActivity('updated', 'client', cid, noteLine + ' (matched existing lead)')
  } else {
    const r = db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status, source, agent_assigned, register_date, tags, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [first || 'Unknown', last || '', cleanEmail, phoneFmt, isSellerCampaign ? 'seller' : 'buyer', 'new', source, 'Matt Smith', now.slice(0, 10), JSON.stringify([tag]),
       // A new lead's intake note was going in unstamped: 23 of the 23 remaining undated
       // notes in the Hub came from this one line (John, 2026-10-05).
       prependClientNote('', noteLine, { by: portalName || 'intake' }), now, now])
    cid = r.lastInsertRowid
    logActivity('created', 'client', cid, noteLine)
  }
  try { import('./routes/inbox.js').then(m => m.claimUnknownCommsForClient(cid)).catch(() => {}) } catch {}
  // NEW leads only (John, 2026-09-17): a brand-new ad registrant gets the ~5-minute
  // first text from JOHN'S APPROVED TEMPLATE BANK (fb-ad-templates.js — never
  // Claude-composed), referencing the property from the ad. An EXISTING lead who
  // re-registers gets the tag + note + notification ONLY; the team decides.
  if (!existing && !isSellerCampaign && fromFacebook) {
    try {
      import('./ai-enrollment.js').then(m => {
        if ((db.getSetting('ai_auto_enroll_mode', 'off') || 'off') === 'off') return
        const ev = m.evaluateAiEnrollmentEligibility(cid, { fbIntake: true })
        m.logEnrollmentDecision(ev, { actor: 'fb_ad_intake' })
        if (ev.decision === 'eligible') m.enrollLead({ ...ev, lane: 'fresh' }, {
          actor: 'fb_ad_intake', firstAtIso: m.nextAllowedIso(new Date(Date.now() + 5 * 60000)),
          routeAction: 'AI_FB_AD_OPENER', routePayload: { property: String(listing || '').trim() },
        })
      }).catch(() => {})
    } catch {}
    // 30-day property-interest follow-up (John, 2026-09-18): Days 2→30 after the
    // opener. Self-gates on its master switch; a reply on any channel stops it.
    try { import('./fb-listing-campaign.js').then(m => m.enrollFbListingCampaign(cid, listing, { actor: 'fb_ad_intake' })).catch(() => {}) } catch {}
  }
  // Fix It or Skip It seller family (John, 2026-09-19): mine the form answers,
  // store structured seller fields + exact-campaign attribution, task + notify,
  // and start the CONTEXTUAL opener sequence (never a generic thanks-text).
  // The Fix It or Skip It family is a Meta campaign, so it only runs for Facebook. A
  // portal seller inquiry is still TYPED seller and tagged; the team works it.
  if (isSellerCampaign && fromFacebook) {
    try { import('./seller-campaign.js').then(m => m.handleSellerLead({ client_id: cid, campaign_raw: listing, raw_text: raw || `${noteLine}
${timeline}`, isExisting: !!existing })).catch(e => console.error('[seller-campaign]', e.message)) } catch {}
  }
  if (!isSellerCampaign) try {
    import('./notifications.js').then(m => m.notify({
      type: 'fb_lead', title: `${fromFacebook ? 'Facebook ad lead' : portalName + ' lead'}: ${(first + ' ' + last).trim() || phoneFmt || cleanEmail || 'unknown'}${existing ? ' (existing lead!)' : ''}`,
      body: `${listing || (fromFacebook ? 'listing ad' : portalName)}${timeline ? ` · timeline: ${timeline}` : ''}${phoneFmt ? ` · ${phoneFmt}` : ''}`,
      link: `/clients/${cid}`, client_id: cid, dedupKey: `fb_lead_${cid}_${now.slice(0, 10)}`,
    })).catch(() => {})
  } catch {}
  // The Hub's OWN alert email to John + Matt with a View Lead button straight to the
  // HUB profile (John, 2026-09-17) — fires for every New Lead and Lead Alert.
  sendFbLeadAlertEmail({ cid, name: `${first} ${last}`.trim(), phone: phoneFmt, email: cleanEmail, listing, timeline, existing: !!existing, seller: isSellerCampaign, portal: portalName }).catch(() => {})
  return { client_id: cid, matched_existing: !!existing }
}
