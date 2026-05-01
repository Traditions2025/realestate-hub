import { Router } from 'express'
import db from '../database.js'
import { TRANSACTION_TEMPLATES, PRELISTING_TEMPLATES, fillMergeVars, buildMergeVars, lookupCloser } from '../transaction-email-templates.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ''
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'mattsmithremax@gmail.com'
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Matt Smith Team'
const REPLY_TO = process.env.SENDGRID_REPLY_TO || 'matt@mattsmithteam.com'

// Always-CC recipients on transaction-related emails (team coordination)
const TRANSACTION_ALWAYS_CC = ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com']

// Closer info — resolved at request time from partners table (with env-var fallback)
// See lookupCloser() in ../transaction-email-templates.js

// Email signature - appended to all template emails
const SIGNATURE = `

—
Matt Smith
Broker Associate | Residential, Commercial, Ag Real Estate
Licensed in the State of Iowa
Matt Smith Team | RE/MAX Concepts
Local Trusted Realtor with 35+ years of Experience | Over 2,000 homes sold

Phone: (319) 431-5859
Website: https://www.mattsmithteam.com
Office: RE/MAX Concepts, 5235 Buffalo Rdg Dr NE, Cedar Rapids, IA 52411`

// Email templates with merge variables: {{first_name}}, {{last_name}}, {{address}}
const TEMPLATES = {
  'follow_up': {
    name: 'Follow Up',
    subject: 'Following up on your home search',
    body: `Hi {{first_name}},

Just checking in to see how your home search is going. I wanted to make sure you have everything you need.

Have any questions about the Cedar Rapids market or specific neighborhoods? I'm here to help.

Talk soon,${SIGNATURE}`
  },
  'just_listed': {
    name: 'Just Listed',
    subject: 'New Listing in {{city}} - You should see this',
    body: `Hi {{first_name}},

A new listing just hit the market in {{city}} that fits what you're looking for. Want to be among the first to see it before this weekend?

Reply or text me back and I'll send the full details + schedule a showing.${SIGNATURE}`
  },
  'market_update': {
    name: 'Market Update',
    subject: 'Cedar Rapids market update for {{city}}',
    body: `Hi {{first_name}},

Quick market snapshot for the Cedar Rapids metro area:

- Inventory continues to favor sellers in your price range
- Average days on market trending shorter
- Interest rates holding steady this month

Curious what your home would sell for in today's market? I'd be glad to put together a free home value estimate.${SIGNATURE}`
  },
  'home_value': {
    name: 'Home Value Check-in',
    subject: 'What\'s your home worth in 2026?',
    body: `Hi {{first_name}},

Quick question - have you wondered what your home at {{address}} is worth in today's market?

Values in your neighborhood have shifted in the last year. I can put together a free, no-obligation home value report based on recent sales nearby.

Just reply "yes" and I'll send it over.${SIGNATURE}`
  },
  'past_client': {
    name: 'Past Client Check-in',
    subject: 'Hope all is well',
    body: `Hi {{first_name}},

Hope you're doing well. Just thinking of you and wanted to check in.

If you ever know anyone thinking about buying or selling in Cedar Rapids, I'd appreciate the introduction. And if you ever have real estate questions yourself, I'm always here.${SIGNATURE}`
  },
  'showing_followup': {
    name: 'Showing Follow-Up',
    subject: 'How was the showing?',
    body: `Hi {{first_name}},

Wanted to follow up on the showing today. What did you think?

Anything specific that stood out (good or bad)? I'm happy to schedule another look or pull comps so we can decide on next steps.${SIGNATURE}`
  },
}

router.get('/templates', (req, res) => {
  res.json(Object.entries(TEMPLATES).map(([id, t]) => ({ id, ...t })))
})

function fillTemplate(text, client) {
  if (!text) return ''
  return text
    .replace(/\{\{first_name\}\}/g, client.first_name || 'there')
    .replace(/\{\{last_name\}\}/g, client.last_name || '')
    .replace(/\{\{full_name\}\}/g, `${client.first_name || ''} ${client.last_name || ''}`.trim())
    .replace(/\{\{email\}\}/g, client.email || '')
    .replace(/\{\{phone\}\}/g, client.phone || '')
    .replace(/\{\{address\}\}/g, client.address || 'your home')
    .replace(/\{\{city\}\}/g, client.city || 'Cedar Rapids')
    .replace(/\{\{agent\}\}/g, client.agent_assigned || 'Matt Smith')
}

// Preview a template filled with client data
router.get('/preview/:templateId/:clientId', (req, res) => {
  const tpl = TEMPLATES[req.params.templateId]
  if (!tpl) return res.status(404).json({ error: 'Template not found' })
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(req.params.clientId)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  res.json({
    subject: fillTemplate(tpl.subject, client),
    body: fillTemplate(tpl.body, client),
  })
})

// Send a single email via SendGrid (supports CC + BCC)
async function sendViaSendGrid(to, toName, subject, body, replyTo, ccList = []) {
  if (!SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY not set on server. Add it as an environment variable on Render.')
  }
  const personalization = { to: [{ email: to, name: toName || undefined }] }
  if (ccList && ccList.length) {
    // Dedupe and exclude the primary recipient from CC
    const uniqueCc = [...new Set(ccList.filter(e => e && e.toLowerCase() !== to.toLowerCase()))]
    if (uniqueCc.length) personalization.cc = uniqueCc.map(email => ({ email }))
  }
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [personalization],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      reply_to: { email: replyTo || REPLY_TO, name: FROM_NAME },
      subject,
      content: [
        { type: 'text/plain', value: body },
        { type: 'text/html', value: body.replace(/\n/g, '<br>') },
      ],
    }),
  })

  if (resp.status === 202) {
    return { success: true, messageId: resp.headers.get('x-message-id') }
  }
  const errText = await resp.text()
  throw new Error(`SendGrid ${resp.status}: ${errText.substring(0, 200)}`)
}

// Send to a single client
router.post('/send', async (req, res) => {
  const { client_id, to_email, subject, body, template } = req.body
  let client = null
  let recipient = to_email

  if (client_id) {
    client = db.get('SELECT * FROM clients WHERE id = ?', [Number(client_id)])
    if (!client) return res.status(404).json({ error: 'Client not found' })
    recipient = recipient || client.email
  }

  if (!recipient) return res.status(400).json({ error: 'No recipient email' })
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' })

  // Block opt-outs
  if (client && client.marketing_email_opt_out) {
    return res.status(400).json({ error: 'Client has opted out of marketing emails' })
  }
  if (client && (client.email_status === 'OptedOut' || client.email_status === 'WrongAddress' || client.email_status === 'ReportedAsSpam')) {
    return res.status(400).json({ error: `Cannot email - status: ${client.email_status}` })
  }

  const filledSubject = client ? fillTemplate(subject, client) : subject
  const filledBody = client ? fillTemplate(body, client) : body

  try {
    const result = await sendViaSendGrid(
      recipient,
      client ? `${client.first_name} ${client.last_name}` : null,
      filledSubject,
      filledBody
    )
    db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
      template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [n(client_id), recipient, FROM_EMAIL, FROM_NAME, filledSubject, filledBody,
        n(template), 'sent', 'sendgrid', n(result.messageId), n(req.body.sent_by) || 'team'])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_sent', 'client', client_id || null, `Email sent to ${recipient}: ${filledSubject}`])
    res.json({ success: true, messageId: result.messageId })
  } catch (err) {
    db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, error)
      VALUES (?,?,?,?,?,?,?)`,
      [n(client_id), recipient, filledSubject, filledBody, n(template), 'failed', err.message])
    res.status(500).json({ error: err.message })
  }
})

// Bulk send to filtered group of clients
router.post('/bulk', async (req, res) => {
  const { client_ids, subject, body, template } = req.body
  if (!Array.isArray(client_ids) || client_ids.length === 0) {
    return res.status(400).json({ error: 'client_ids required' })
  }
  if (client_ids.length > 2000) {
    return res.status(400).json({ error: 'Max 2000 recipients per bulk send. Send in batches.' })
  }

  let sent = 0, failed = 0, skipped = 0
  const errors = []

  for (const id of client_ids) {
    const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(id)])
    if (!client || !client.email) { skipped++; continue }
    if (client.marketing_email_opt_out) { skipped++; continue }
    if (['OptedOut', 'WrongAddress', 'ReportedAsSpam'].includes(client.email_status)) { skipped++; continue }

    try {
      const result = await sendViaSendGrid(
        client.email,
        `${client.first_name} ${client.last_name}`,
        fillTemplate(subject, client),
        fillTemplate(body, client)
      )
      db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
        template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [client.id, client.email, FROM_EMAIL, FROM_NAME, fillTemplate(subject, client),
          fillTemplate(body, client), n(template), 'sent', 'sendgrid', n(result.messageId), 'team'])
      sent++
    } catch (err) {
      failed++
      errors.push({ client_id: id, error: err.message })
    }
  }

  db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
    ['bulk_email', 'client', `Bulk email sent: ${sent} sent, ${failed} failed, ${skipped} skipped`])

  res.json({ success: true, sent, failed, skipped, errors: errors.slice(0, 10) })
})

// Email history for a client
router.get('/history/:clientId', (req, res) => {
  const rows = db.all('SELECT * FROM email_log WHERE client_id = ? ORDER BY sent_at DESC LIMIT 50',
    [Number(req.params.clientId)])
  res.json(rows)
})

// Total email stats
router.get('/stats', (req, res) => {
  const sent = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'sent'").c
  const failed = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'failed'").c
  const today = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'sent' AND sent_at >= date('now')").c
  res.json({ total_sent: sent, total_failed: failed, sent_today: today })
})

router.get('/check-config', (req, res) => {
  res.json({
    configured: !!SENDGRID_API_KEY,
    from_email: FROM_EMAIL,
    from_name: FROM_NAME,
  })
})

// =========================================================
// TRANSACTION & PRE-LISTING TEMPLATES + SEND
// =========================================================

// List available transaction templates
router.get('/transaction-templates', (_req, res) => {
  const list = Object.entries(TRANSACTION_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    role: t.role,
    recipient: t.recipient,
    subject: t.subject,
  }))
  res.json(list)
})

// List available pre-listing templates
router.get('/prelisting-templates', (_req, res) => {
  const list = Object.entries(PRELISTING_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    recipient: t.recipient,
    subject: t.subject,
  }))
  res.json(list)
})

// Preview a transaction template — fills merge vars from transaction + linked client
router.get('/transaction-preview/:templateId/:transactionId', (req, res) => {
  const tpl = TRANSACTION_TEMPLATES[req.params.templateId]
  if (!tpl) return res.status(404).json({ error: 'Template not found' })
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [Number(req.params.transactionId)])
  if (!tx) return res.status(404).json({ error: 'Transaction not found' })
  const client = tx.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [tx.client_id]) : null
  const vars = buildMergeVars(client, tx)
  res.json({
    template_id: req.params.templateId,
    name: tpl.name,
    role: tpl.role,
    recipient: tpl.recipient,
    subject: fillMergeVars(tpl.subject, vars),
    body: fillMergeVars(tpl.body, vars),
    suggested_to: resolveRecipient(tpl.recipient, client, tx),
    auto_cc: TRANSACTION_ALWAYS_CC,
  })
})

// Preview a pre-listing template
router.get('/prelisting-preview/:templateId/:preListingId', (req, res) => {
  const tpl = PRELISTING_TEMPLATES[req.params.templateId]
  if (!tpl) return res.status(404).json({ error: 'Template not found' })
  const pl = db.get('SELECT * FROM pre_listings WHERE id = ?', [Number(req.params.preListingId)])
  if (!pl) return res.status(404).json({ error: 'Pre-listing not found' })
  const client = pl.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [pl.client_id]) : null
  const vars = buildMergeVars(client, { property_address: pl.property_address })
  res.json({
    template_id: req.params.templateId,
    name: tpl.name,
    subject: fillMergeVars(tpl.subject, vars),
    body: fillMergeVars(tpl.body, vars),
    suggested_to: client?.email || '',
  })
})

function resolveRecipient(recipientType, client, tx) {
  if (recipientType === 'client') return client?.email || ''
  if (recipientType === 'lender') return '' // Lender email isn't stored; user must enter
  if (recipientType === 'closer') return lookupCloser().email || ''
  return ''
}

// Endpoint so the frontend can pre-populate Cherryl's email when "Email Cherryl" is clicked
router.get('/closer-info', (_req, res) => {
  res.json(lookupCloser())
})

// Send a pre-listing email (always CCs the team — same coordination policy)
router.post('/send-prelisting', async (req, res) => {
  const { pre_listing_id, to_email, to_name, subject, body, template_id, additional_cc } = req.body
  if (!to_email || !subject || !body) {
    return res.status(400).json({ error: 'to_email, subject, and body are required' })
  }
  const pl = pre_listing_id ? db.get('SELECT * FROM pre_listings WHERE id = ?', [Number(pre_listing_id)]) : null
  const client = pl?.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [pl.client_id]) : null

  const ccList = [...TRANSACTION_ALWAYS_CC]
  if (Array.isArray(additional_cc)) ccList.push(...additional_cc.filter(Boolean))

  try {
    const result = await sendViaSendGrid(to_email, to_name, subject, body, REPLY_TO, ccList)
    db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
      template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [n(client?.id), to_email, FROM_EMAIL, FROM_NAME, subject, body,
        n(template_id), 'sent', 'sendgrid', n(result.messageId), n(req.body.sent_by) || 'team'])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_sent', 'pre_listing', pl?.id || null, `Pre-listing email sent to ${to_email}: ${subject}`])
    res.json({ success: true, messageId: result.messageId, cc: ccList })
  } catch (err) {
    db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, error)
      VALUES (?,?,?,?,?,?,?)`,
      [n(client?.id), to_email, subject, body, n(template_id), 'failed', err.message])
    res.status(500).json({ error: err.message })
  }
})

// Send a transaction-related email (always CCs the team)
router.post('/send-transaction', async (req, res) => {
  const { transaction_id, to_email, to_name, subject, body, template_id, additional_cc } = req.body
  if (!to_email || !subject || !body) {
    return res.status(400).json({ error: 'to_email, subject, and body are required' })
  }
  const tx = transaction_id ? db.get('SELECT * FROM transactions WHERE id = ?', [Number(transaction_id)]) : null
  const client = tx?.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [tx.client_id]) : null

  // Build CC list: always-CC team members + any additional from request
  const ccList = [...TRANSACTION_ALWAYS_CC]
  if (Array.isArray(additional_cc)) ccList.push(...additional_cc.filter(Boolean))

  try {
    const result = await sendViaSendGrid(to_email, to_name, subject, body, REPLY_TO, ccList)
    db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
      template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [n(client?.id), to_email, FROM_EMAIL, FROM_NAME, subject, body,
        n(template_id), 'sent', 'sendgrid', n(result.messageId), n(req.body.sent_by) || 'team'])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_sent', 'transaction', tx?.id || null, `Transaction email sent to ${to_email} (CC: ${ccList.join(', ')}): ${subject}`])
    res.json({ success: true, messageId: result.messageId, cc: ccList })
  } catch (err) {
    db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, error)
      VALUES (?,?,?,?,?,?,?)`,
      [n(client?.id), to_email, subject, body, n(template_id), 'failed', err.message])
    res.status(500).json({ error: err.message })
  }
})

export default router
