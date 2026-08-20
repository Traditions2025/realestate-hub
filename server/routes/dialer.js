// Power Dialer — builds a call queue and logs the outcome of each call, so the
// existing browser softphone becomes a call-through-a-list workflow. Calling is
// never hard-blocked, but Do Not Contact / Junk leads are kept OUT of dialer queues.
import { Router } from 'express'
import db from '../database.js'
import { isStopStatus, stopSequencesForClient } from '../lead-sequences.js'

const router = Router()
const nowIso = () => new Date().toISOString()
const STOP = "(clients.status IS NULL OR lower(clients.status) NOT IN ('junk','donotcontact'))"

// last outbound call + last contact of any kind, per client (for ordering + display)
const CONTACT_COLS = `
  (SELECT MAX(occurred_at) FROM communications WHERE client_id = clients.id AND channel='call') AS last_call_at,
  (SELECT MAX(occurred_at) FROM communications WHERE client_id = clients.id) AS last_contact_at`

function shape(rows) {
  return rows.map(c => ({
    id: c.id,
    name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone,
    phone: c.phone, status: c.status, agent_assigned: c.agent_assigned, source: c.source,
    city: c.city, type: c.type, last_call_at: c.last_call_at, last_contact_at: c.last_contact_at,
    notes: (c.notes || '').split('\n').filter(Boolean).slice(-1)[0] || '',
  }))
}

// GET /api/dialer/queue?preset=&assigned=&status=&limit=&client_ids=
router.get('/queue', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 40))
  const idsRaw = String(req.query.client_ids || '').trim()
  // Explicit selection (from the Clients page) wins over presets.
  if (idsRaw) {
    const ids = idsRaw.split(',').map(n => Number(n)).filter(Boolean).slice(0, 200)
    if (!ids.length) return res.json([])
    const rows = db.all(`SELECT clients.*, ${CONTACT_COLS} FROM clients
      WHERE clients.id IN (${ids.map(() => '?').join(',')}) AND phone IS NOT NULL AND phone != '' AND ${STOP}`, ids)
    // preserve the caller's order
    const order = new Map(ids.map((id, i) => [id, i]))
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    return res.json(shape(rows))
  }
  const preset = String(req.query.preset || 'oldest_contact')
  const assigned = String(req.query.assigned || '').trim()
  const status = String(req.query.status || '').trim()
  const where = [`phone IS NOT NULL AND phone != ''`, STOP]
  const params = []
  if (assigned) { where.push('agent_assigned = ?'); params.push(assigned) }
  if (status) { where.push('lower(status) = lower(?)'); params.push(status) }
  let order = 'last_contact_at ASC'
  if (preset === 'never_called') {
    where.push(`NOT EXISTS (SELECT 1 FROM communications WHERE client_id = clients.id AND channel='call' AND direction='outgoing')`)
    order = 'clients.created_at DESC'
  } else if (preset === 'new_leads') {
    where.push(`clients.created_at >= datetime('now','-30 days')`)
    order = 'clients.created_at DESC'
  } // 'oldest_contact' (default) and 'assigned' use last_contact_at ASC (least-recently-touched first)
  const rows = db.all(`SELECT clients.*, ${CONTACT_COLS} FROM clients
    WHERE ${where.join(' AND ')} ORDER BY ${order} NULLS FIRST, clients.id DESC LIMIT ?`, [...params, limit])
  res.json(shape(rows))
})

// POST /api/dialer/outcome  { client_id, disposition, notes }
// Applies the outcome to the most recent call log for the contact (or creates one),
// emits the call_disposition automation event, and handles "Do not call".
router.post('/outcome', (req, res) => {
  const cid = Number(req.body?.client_id)
  const disposition = (req.body?.disposition || '').trim()
  const notes = req.body?.notes != null ? String(req.body.notes) : null
  const c = db.get('SELECT id, first_name, last_name, phone FROM clients WHERE id=?', [cid])
  if (!c) return res.status(404).json({ error: 'client not found' })
  // Find a call/voicemail row from the last 2 hours to annotate; else log a new one.
  let row = db.get(`SELECT id FROM communications WHERE client_id=? AND channel IN ('call','voicemail')
    AND occurred_at >= datetime('now','-2 hours') ORDER BY occurred_at DESC LIMIT 1`, [cid])
  if (row) {
    const sets = [], vals = []
    if (disposition) { sets.push('disposition=?'); vals.push(disposition) }
    if (notes != null) { sets.push('notes=?'); vals.push(notes) }
    if (sets.length) { vals.push(row.id); db.run(`UPDATE communications SET ${sets.join(', ')} WHERE id=?`, vals) }
  } else {
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
    db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, external_id, thread_key, status, disposition, notes, agent, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['call', 'outgoing', cid, name, '', c.phone || '', `Call — ${disposition || 'logged'}`, 'dialer_' + cid + '_' + Date.now(), `c${cid}_call`, 'read', disposition || null, notes, req.body?.agent || 'dialer', nowIso()])
  }
  // Call-list log for the Reporting tab.
  db.run('INSERT INTO dialer_log (client_id, contact_name, phone, disposition, notes, agent) VALUES (?,?,?,?,?,?)',
    [cid, `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone, c.phone || '', disposition || null, notes, req.body?.agent || null])
  if (disposition) import('./automations.js').then(m => m.emitAutomationEvent('call_disposition', cid, { disposition }, `disp_dialer_${cid}_${Date.now()}`)).catch(() => {})
  // "Do not call" → Do Not Contact status + remove all campaigns (mirrors the inbox disposition).
  if (disposition.toLowerCase() === 'do not call') {
    db.run("UPDATE clients SET status='donotcontact', updated_at=? WHERE id=?", [nowIso(), cid])
    stopSequencesForClient(cid, 'do not call (dialer)')
  }
  res.json({ success: true })
})

export default router
