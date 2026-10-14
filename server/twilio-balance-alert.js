// Email the team when the Twilio balance runs low.
//
// John, 2026-10-14: "we should be getting an email when balance is becoming low under $5."
//
// Twilio does not fail loudly when the balance runs out: texts stop going out and calls
// stop connecting, and the first sign is a lead who never heard from us. The Hub already
// reads the live balance for the Settings page; this watches it on a schedule instead.
//
// Noise control: one email when it first drops below the threshold, then at most one a day
// while it stays low, and the alert re-arms as soon as a top-up puts it back above. A
// balance Twilio will not tell us (an unreachable API, a suspended account) is never
// treated as zero — no reading means no alert.
import db from './database.js'
import { twilioConfig } from './twilio.js'
import { sendViaSendGrid } from './routes/email.js'
import { chicagoDateKey } from './transaction-digest.js'

const THRESHOLD_KEY = 'twilio_balance_alert_threshold'
const RECIPIENTS_KEY = 'twilio_balance_alert_to'
const LAST_SENT_KEY = 'twilio_balance_alert_last_sent'   // Chicago date key of the last email
const LAST_LEVEL_KEY = 'twilio_balance_alert_last_level'  // 'low' | 'ok', so a top-up re-arms

export const DEFAULT_THRESHOLD = 5
const DEFAULT_RECIPIENTS = 'mattsmithremax@gmail.com, johnwithmattsmithteam@gmail.com'

// A blank setting means "unset", not "zero" and not "nobody". Saving an empty box in
// Settings stores '', and reading that literally would set the threshold to 0 — which can
// never be met, so the alert would simply never fire again, silently. Same for recipients:
// an empty list is indistinguishable from a working alert that emails no one.
export function alertThreshold() {
  const raw = String(db.getSetting(THRESHOLD_KEY, '') || '').trim()
  if (!raw) return DEFAULT_THRESHOLD
  const v = Number(raw)
  // > 0, not >= 0: a threshold of 0 is always unmet, which is a disabled alert wearing the
  // costume of a working one.
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_THRESHOLD
}
export function alertRecipients() {
  const raw = String(db.getSetting(RECIPIENTS_KEY, '') || '').trim() || DEFAULT_RECIPIENTS
  return raw.split(',').map(s => s.trim()).filter(s => s.includes('@'))
}

/** Live balance from Twilio. { balance, currency } — balance is null when unknown. */
export async function readBalance() {
  const c = twilioConfig()
  if (!c.sid || !c.token) return { balance: null, currency: 'USD', error: 'Twilio not configured' }
  const auth = 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Balance.json`, { headers: { Authorization: auth } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { balance: null, currency: 'USD', error: j?.message || `HTTP ${r.status}` }
    const n = Number(j.balance)
    return { balance: Number.isFinite(n) ? n : null, currency: j.currency || 'USD', error: null }
  } catch (e) { return { balance: null, currency: 'USD', error: e.message } }
}

function emailHtml(balance, currency, threshold) {
  const money = (n) => `${currency === 'USD' ? '$' : currency + ' '}${Number(n).toFixed(2)}`
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
<p><b>The Twilio balance is down to ${money(balance)}.</b></p>
<p>That is below the ${money(threshold)} mark we watch for. When it reaches zero, texts stop
going out and calls stop connecting, and nothing in the Hub announces it — the first sign is
usually a lead who never heard back.</p>
<p>Top up here: <a href="https://console.twilio.com/us1/billing/manage-billing/billing-overview">Twilio billing overview</a></p>
<p style="color:#64748b;font-size:13px;">Sent once when the balance first drops below
${money(threshold)}, then at most once a day until it is topped up. Checked hourly by the Hub.</p>
</div>`
}

/**
 * Check the balance and email if it is low.
 * `dry` reads and decides but never sends — safe to call while investigating.
 * `force` sends even if one already went out today (still requires a low balance).
 */
export async function checkTwilioBalance({ dry = false, force = false } = {}) {
  const threshold = alertThreshold()
  const { balance, currency, error } = await readBalance()
  const today = chicagoDateKey()

  // Unknown is not zero. An API blip must never fire a "you are out of money" email.
  if (balance === null) return { checked: true, balance: null, threshold, error, action: 'skipped_unknown_balance' }

  if (balance >= threshold) {
    if (!dry) db.setSetting(LAST_LEVEL_KEY, 'ok')   // re-arm: the next drop alerts at once
    return { checked: true, balance, currency, threshold, low: false, action: 'ok' }
  }

  const lastSent = db.getSetting(LAST_SENT_KEY, '')
  if (!force && lastSent === today) {
    return { checked: true, balance, currency, threshold, low: true, action: 'already_sent_today' }
  }

  const to = alertRecipients()
  if (!to.length) return { checked: true, balance, currency, threshold, low: true, action: 'no_recipients' }
  if (dry) return { checked: true, balance, currency, threshold, low: true, action: 'would_send', to }

  const money = `${currency === 'USD' ? '$' : currency + ' '}${balance.toFixed(2)}`
  const subject = `Twilio balance is low — ${money} left`
  const html = emailHtml(balance, currency, threshold)
  try {
    await sendViaSendGrid(to, 'Matt Smith Team', subject, html, undefined, [], [])
  } catch (e) {
    return { checked: true, balance, currency, threshold, low: true, action: 'send_failed', error: e.message, to }
  }
  db.setSetting(LAST_SENT_KEY, today)
  db.setSetting(LAST_LEVEL_KEY, 'low')
  try {
    db.run(`INSERT INTO email_log (to_email, from_email, from_name, subject, body, template, status, provider, sent_by)
            VALUES (?, ?, ?, ?, ?, ?, 'sent', 'sendgrid', 'scheduler')`,
      [to.join(', '), process.env.SENDGRID_FROM_EMAIL || 'matt@mattsmithteam.com',
       'Matt Smith Team', subject, html, 'twilio-balance-low'])
  } catch {}
  return { checked: true, balance, currency, threshold, low: true, action: 'sent', to }
}
