import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ''
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'mattsmithremax@gmail.com'
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Matt Smith Team'
const REPLY_TO = process.env.SENDGRID_REPLY_TO || 'matt@mattsmithteam.com'

// Email templates with merge variables: {{first_name}}, {{last_name}}, {{address}}
const TEMPLATES = {
  'follow_up': {
    name: 'Follow Up',
    subject: 'Following up on your home search',
    body: `Hi {{first_name}},

Just checking in to see how your home search is going. I wanted to make sure you have everything you need.

Have any questions about the Cedar Rapids market or specific neighborhoods? I'm here to help.

Talk soon,
Matt Smith
Matt Smith Team | RE/MAX Concepts
(319) 431-5859`
  },
  'just_listed': {
    name: 'Just Listed',
    subject: 'New Listing in {{city}} - You should see this',
    body: `Hi {{first_name}},

A new listing just hit the market in {{city}} that fits what you're looking for. Want to be among the first to see it before this weekend?

Reply or text me back and I'll send the full details + schedule a showing.

Matt Smith
(319) 431-5859`
  },
  'market_update': {
    name: 'Market Update',
    subject: 'Cedar Rapids market update for {{city}}',
    body: `Hi {{first_name}},

Quick market snapshot for the Cedar Rapids metro area:

- Inventory continues to favor sellers in your price range
- Average days on market trending shorter
- Interest rates holding steady this month

Curious what your home would sell for in today's market? I'd be glad to put together a free home value estimate.

Matt Smith Team
(319) 431-5859`
  },
  'home_value': {
    name: 'Home Value Check-in',
    subject: 'What\'s your home worth in 2026?',
    body: `Hi {{first_name}},

Quick question - have you wondered what your home at {{address}} is worth in today's market?

Values in your neighborhood have shifted in the last year. I can put together a free, no-obligation home value report based on recent sales nearby.

Just reply "yes" and I'll send it over.

Matt Smith
Matt Smith Team | RE/MAX Concepts`
  },
  'past_client': {
    name: 'Past Client Check-in',
    subject: 'Hope all is well',
    body: `Hi {{first_name}},

Hope you're doing well. Just thinking of you and wanted to check in.

If you ever know anyone thinking about buying or selling in Cedar Rapids, I'd appreciate the introduction. And if you ever have real estate questions yourself, I'm always here.

Matt Smith
Matt Smith Team`
  },
  'showing_followup': {
    name: 'Showing Follow-Up',
    subject: 'How was the showing?',
    body: `Hi {{first_name}},

Wanted to follow up on the showing today. What did you think?

Anything specific that stood out (good or bad)? I'm happy to schedule another look or pull comps so we can decide on next steps.

Matt Smith
(319) 431-5859`
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

// Send a single email via SendGrid
async function sendViaSendGrid(to, toName, subject, body, replyTo) {
  if (!SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY not set on server. Add it as an environment variable on Render.')
  }
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: toName || undefined }] }],
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
  if (client_ids.length > 200) {
    return res.status(400).json({ error: 'Max 200 recipients per bulk send' })
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

export default router
