// Shared Facebook-ad lead intake. One function ingests a lead no matter how it
// arrived (FUB event watcher, the direct fb-webhook, a manual backfill):
// dedupe by phone then email, tag to the listing/campaign, save the timeline
// answer, notify the team, claim any unknown call/text history, and hand the
// lead to the AI fresh lane for the ~5-minute first text.
import db from './database.js'

const nowIso = () => new Date().toISOString()
function logActivity(action, entityType, entityId, details) {
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', [action, entityType, entityId, details]) } catch {}
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
async function sendFbLeadAlertEmail({ cid, name, phone, email, listing, timeline, existing }) {
  try {
    const { sendViaSendGrid } = await import('./routes/email.js')
    const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const who = name || phone || email || 'Unknown'
    const subject = existing
      ? `Facebook Ad Lead (EXISTING): ${who}${listing ? ' — ' + listing : ''}`
      : `New Facebook Ad Lead: ${who}${listing ? ' — ' + listing : ''}`
    const rows = [
      existing ? ['Heads up', 'This is an EXISTING lead in the Hub who just registered on the ad'] : ['Status', 'Brand new lead — created in the Hub, AI first text on the way'],
      ['Listing', listing || '—'], ['Phone', phone || '—'], ['Email', email || '—'], ['Timeline', timeline || '—'],
    ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;white-space:nowrap;">${esc(k)}</td><td style="padding:4px 0;color:#0f172a;"><strong>${esc(v)}</strong></td></tr>`).join('')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
      <p style="margin:0 0 6px;font-size:16px;"><strong>${esc(who)}</strong> ${existing ? 're-registered on' : 'came in from'} your Facebook listing ad.</p>
      <table style="border-collapse:collapse;margin:8px 0 14px;">${rows}</table>
      <p style="margin:0 0 12px;"><a href="${hub}/clients/${cid}" style="display:inline-block;background:#B9963B;color:#241a04;font-weight:700;padding:10px 18px;border-radius:8px;text-decoration:none;">View Lead</a></p>
      <p style="margin:0;color:#64748b;font-size:12px;">Matt Smith Team Hub · Facebook ad lead alert</p></div>`
    await sendViaSendGrid('johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com', 'Matt Smith Team', subject, html, null, [], [], [], 'fb_lead_alert')
  } catch (e) { try { console.error('[fb-lead-alert-email]', e.message) } catch {} }
}

export function ingestFbLead({ first = '', last = '', email = null, phone = null, timeline = '', listing = '', marker = '', source = 'Facebook Listing Ad' } = {}) {
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
  const tag = 'FB Ad' + (listing ? ': ' + String(listing).slice(0, 60) : '')
  const noteLine = `Facebook listing ad lead${listing ? ` (${listing})` : ''}${timeline ? ` — timeline: ${timeline}` : ''}${marker ? ' ' + marker : ''}`
  let cid
  if (existing) {
    cid = existing.id
    let tags = []; try { tags = JSON.parse(existing.tags || '[]') } catch {}
    if (!tags.includes(tag)) tags.push(tag)
    db.run(`UPDATE clients SET tags=?, email=COALESCE(email, ?), phone=COALESCE(NULLIF(phone,''), ?),
            notes=COALESCE(notes,'') || ?, updated_at=? WHERE id=?`,
      [JSON.stringify(tags), cleanEmail, phoneFmt, `\n[${now.slice(0, 10)}] ${noteLine}`, now, cid])
    logActivity('updated', 'client', cid, noteLine + ' (matched existing lead)')
  } else {
    const r = db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status, source, tags, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [first || 'Unknown', last || '', cleanEmail, phoneFmt, 'buyer', 'new', source, JSON.stringify([tag]), noteLine, now, now])
    cid = r.lastInsertRowid
    logActivity('created', 'client', cid, noteLine)
  }
  try { import('./routes/inbox.js').then(m => m.claimUnknownCommsForClient(cid)).catch(() => {}) } catch {}
  // NEW leads only (John, 2026-09-17): a brand-new ad registrant gets the ~5-minute
  // first text from JOHN'S APPROVED TEMPLATE BANK (fb-ad-templates.js — never
  // Claude-composed), referencing the property from the ad. An EXISTING lead who
  // re-registers gets the tag + note + notification ONLY; the team decides.
  if (!existing) {
    try {
      import('./ai-enrollment.js').then(m => {
        if ((db.getSetting('ai_auto_enroll_mode', 'off') || 'off') === 'off') return
        const ev = m.evaluateAiEnrollmentEligibility(cid)
        m.logEnrollmentDecision(ev, { actor: 'fb_ad_intake' })
        if (ev.decision === 'eligible') m.enrollLead({ ...ev, lane: 'fresh' }, {
          actor: 'fb_ad_intake', firstAtIso: m.nextAllowedIso(new Date(Date.now() + 5 * 60000)),
          routeAction: 'AI_FB_AD_OPENER', routePayload: { property: String(listing || '').trim() },
        })
      }).catch(() => {})
    } catch {}
  }
  try {
    import('./notifications.js').then(m => m.notify({
      type: 'fb_lead', title: `Facebook ad lead: ${(first + ' ' + last).trim() || phoneFmt || cleanEmail || 'unknown'}${existing ? ' (existing lead!)' : ''}`,
      body: `${listing || 'listing ad'}${timeline ? ` · timeline: ${timeline}` : ''}${phoneFmt ? ` · ${phoneFmt}` : ''}`,
      link: `/clients/${cid}`, client_id: cid, dedupKey: `fb_lead_${cid}_${now.slice(0, 10)}`,
    })).catch(() => {})
  } catch {}
  // The Hub's OWN alert email to John + Matt with a View Lead button straight to the
  // HUB profile (John, 2026-09-17) — fires for every New Lead and Lead Alert.
  sendFbLeadAlertEmail({ cid, name: `${first} ${last}`.trim(), phone: phoneFmt, email: cleanEmail, listing, timeline, existing: !!existing }).catch(() => {})
  return { client_id: cid, matched_existing: !!existing }
}
