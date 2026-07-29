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

// Build the 10 AM deadline message. Includes:
//  - deadlines due in exactly 3 days or 1 day (tomorrow): Home Inspection,
//    Earnest, Financing/Inspection contingency, Closing, Final Walkthrough, etc.
//  - a "1 week to closing" reminder to check with Cherryl that everything is ready.
// Returns { text, txCount, itemCount, cherrylCount } or null when nothing to report.
export function buildDeadlineMessage() {
  const txs = fetchActiveTransactions()
  const blocks = []
  const cherrylBlocks = []
  let itemCount = 0

  for (const tx of txs) {
    const items = buildActionItems(tx)
    // The final walkthrough form is only needed AFTER the walkthrough, so it's
    // handled by the day-of task + 5 PM reminder — not the pre-emptive alert.
    const due = items.filter(it => (it.daysOut === 3 || it.daysOut === 1) && it.label !== 'Final walkthrough')
    if (due.length) {
      itemCount += due.length
      const lines = due
        .sort((a, b) => a.daysOut - b.daysOut)
        .map(it => {
          const emoji = it.daysOut === 1 ? ':red_circle:' : ':large_orange_circle:'
          const when = it.daysOut === 1 ? 'TOMORROW' : 'in 3 days'
          return `   • ${emoji} *${when}* — ${it.label}${it.date ? ` (${fmtDate(it.date)})` : ''}`
        })
      blocks.push(`*${tx.property_address || 'Address TBD'}*  _(${representedLabel(tx)})_\n${lines.join('\n')}`)
    }
    // 1 week before closing — nudge to confirm readiness with Cherryl
    const closing = items.find(it => it.label === 'Closing')
    if (closing && closing.daysOut === 7) {
      cherrylBlocks.push(`   • *${tx.property_address || 'Address TBD'}* closes ${closing.date ? fmtDate(closing.date) : 'in 1 week'} — check with *Cherryl* that everything is ready for closing`)
    }
  }

  const sections = []
  if (blocks.length) sections.push(`:calendar: *Transaction Deadlines*\n_Due tomorrow or in 3 days_\n\n${blocks.join('\n\n')}`)
  if (cherrylBlocks.length) sections.push(`:date: *1 Week to Closing*\n${cherrylBlocks.join('\n')}`)
  if (!sections.length) return null

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const text = `*${today}*\n\n${sections.join('\n\n')}`
  return { text, txCount: blocks.length, itemCount, cherrylCount: cherrylBlocks.length }
}

// Fire the deadline alert now. Returns a result object for logging.
export async function runDeadlineAlert() {
  const msg = buildDeadlineMessage()
  if (!msg) {
    return { posted: false, reason: 'nothing due (3d/1d) or closing in a week', txCount: 0, itemCount: 0 }
  }
  const ok = await postSlack(msg.text)
  return { posted: ok, txCount: msg.txCount, itemCount: msg.itemCount + (msg.cherrylCount || 0) }
}

// Reminder posted at 5 PM CT on any transaction's final walkthrough day.
export async function runFinalWalkthroughReminder() {
  const txs = fetchActiveTransactions()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const lines = []
  for (const tx of txs) {
    if (tx.final_walkthrough && String(tx.final_walkthrough).slice(0, 10) === today) {
      lines.push(`   • *${tx.property_address || 'Address TBD'}* — confirm the *Final Walkthrough is signed by the buyers*`)
    }
  }
  if (!lines.length) return { posted: false, count: 0 }
  const ok = await postSlack(`:walking: *Final Walkthrough Today*\n${lines.join('\n')}`)
  return { posted: ok, count: lines.length }
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
