// =====================================================================
// SLACK NOTIFICATIONS
// Posts to a single Incoming Webhook (channel #transaction-tasks-deadlines).
//   1. Daily 10 AM CT deadline alert — every active/under-contract transaction
//      (buy + list) whose deadlines are due in exactly 3 days OR today.
//   2. Task alert — fired when a new task is created so nothing slips by.
//
// The webhook URL is read from SLACK_WEBHOOK_URL (set it on Render to rotate);
// the fallback keeps it working out of the box. If neither is present the
// helpers no-op quietly so the rest of the app is unaffected.
// =====================================================================
import { fetchActiveTransactions, buildActionItems } from './transaction-digest.js'
import { getSetting } from './database.js'

// Webhook URL is read at call time from the env var (preferred, set on Render)
// or the app_settings table (set live via POST /api/slack/config). It is never
// stored in source control — GitHub push protection blocks that, correctly.
function webhookUrl() {
  return process.env.SLACK_WEBHOOK_URL || getSetting('slack_webhook_url') || null
}

// Post raw text (Slack mrkdwn) to the webhook. Returns true on success.
export async function postSlack(text) {
  const url = webhookUrl()
  if (!url) { console.warn('[slack] no webhook configured — skipping post'); return false }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const body = await resp.text()
    if (!resp.ok || body.trim() !== 'ok') {
      console.error(`[slack] post failed: ${resp.status} ${body.slice(0, 120)}`)
      return false
    }
    return true
  } catch (e) {
    console.error('[slack] post error:', e.message)
    return false
  }
}

// Who we represent, from agency_type (mirrors the Dashboard logic).
function representedLabel(tx) {
  const a = String(tx.agency_type || '').toLowerCase()
  if (a.includes('dual') || a.includes('both')) {
    const both = [tx.seller_name, tx.buyer_name].filter(Boolean).join(' / ')
    return both ? `Dual · ${both}` : 'Dual agency'
  }
  if (a.includes('listing') || a.includes('seller')) return `Listing · ${tx.seller_name || 'seller'}`
  if (a.includes('buyer')) return `Buyer · ${tx.buyer_name || 'buyer'}`
  // agency_type blank — fall back to deal type
  if (tx.type === 'listing') return `Listing · ${tx.seller_name || 'seller'}`
  if (tx.type === 'purchase') return `Buyer · ${tx.buyer_name || 'buyer'}`
  return tx.buyer_name || tx.seller_name || 'Transaction'
}

const fmtDate = (s) => {
  if (!s) return ''
  const d = new Date(s.includes('T') ? s : s + 'T00:00:00')
  if (isNaN(d)) return s
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Build the 10 AM deadline message. Only deadlines due in exactly 3 days or
// today are included (per the alert spec). Returns { text, txCount, itemCount }
// or null when there's nothing to report.
export function buildDeadlineMessage() {
  const txs = fetchActiveTransactions()
  const blocks = []
  let itemCount = 0

  for (const tx of txs) {
    const due = buildActionItems(tx).filter(it => it.daysOut === 0 || it.daysOut === 3)
    if (!due.length) continue
    itemCount += due.length
    const lines = due
      .sort((a, b) => a.daysOut - b.daysOut)
      .map(it => {
        const emoji = it.daysOut === 0 ? ':red_circle:' : ':large_orange_circle:'
        const when = it.daysOut === 0 ? 'TODAY' : 'in 3 days'
        return `   • ${emoji} *${when}* — ${it.label}${it.date ? ` (${fmtDate(it.date)})` : ''}`
      })
    blocks.push(`*${tx.property_address || 'Address TBD'}*  _(${representedLabel(tx)})_\n${lines.join('\n')}`)
  }

  if (!blocks.length) return null
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const text = `:calendar: *Transaction Deadlines — ${today}*\n_Due today or in 3 days_\n\n${blocks.join('\n\n')}`
  return { text, txCount: blocks.length, itemCount }
}

// Fire the deadline alert now. Returns a result object for logging.
export async function runDeadlineAlert() {
  const msg = buildDeadlineMessage()
  if (!msg) {
    return { posted: false, reason: 'no deadlines due today or in 3 days', txCount: 0, itemCount: 0 }
  }
  const ok = await postSlack(msg.text)
  return { posted: ok, txCount: msg.txCount, itemCount: msg.itemCount }
}

// Notify Slack when a new task is created. Fire-and-forget from the route.
export async function notifyTaskCreated(task) {
  if (!task) return false
  const prio = task.priority ? task.priority.toUpperCase() : 'NORMAL'
  const emoji = task.priority === 'high' ? ':rotating_light:' : ':memo:'
  const bits = [`Priority: *${prio}*`]
  if (task.due_date) bits.push(`Due: ${fmtDate(task.due_date)}`)
  if (task.assigned_to) bits.push(`For: ${task.assigned_to}`)
  if (task.category) bits.push(task.category)
  const text = `${emoji} *New task* — ${task.title}\n   ${bits.join(' · ')}`
  return postSlack(text)
}
