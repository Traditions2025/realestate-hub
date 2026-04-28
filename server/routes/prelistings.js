import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

router.get('/', (req, res) => {
  const { status, search } = req.query
  let sql = 'SELECT * FROM pre_listings WHERE 1=1'
  const params = []
  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (search) { sql += ' AND (property_address LIKE ? OR owner_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
  sql += ' ORDER BY updated_at DESC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM pre_listings WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO pre_listings (property_address, owner_name, walkthrough, status,
    marketing_materials_sent, seller_discovery_form, cma, seller_netsheet, loop_created,
    listing_contract_signed, getting_home_ready, schedule_photoshoot, get_spare_keys,
    install_lockbox, install_signs, written_description, coming_soon_post, coming_soon_email,
    listing_submitted_mls, posted_social_media, notes, client_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.property_address, n(b.owner_name), n(b.walkthrough) || 'Not Scheduled', n(b.status) || 'New',
      b.marketing_materials_sent || 0, b.seller_discovery_form || 0, b.cma || 0, b.seller_netsheet || 0,
      b.loop_created || 0, b.listing_contract_signed || 0, b.getting_home_ready || 0,
      b.schedule_photoshoot || 0, b.get_spare_keys || 0, b.install_lockbox || 0,
      b.install_signs || 0, b.written_description || 0, b.coming_soon_post || 0,
      b.coming_soon_email || 0, b.listing_submitted_mls || 0, b.posted_social_media || 0,
      n(b.notes), n(b.client_id)])

  logActivity('created', 'pre_listing', result.lastInsertRowid, `New pre-listing: ${b.property_address}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE pre_listings SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'pre_listing', Number(req.params.id), 'Updated pre-listing')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM pre_listings WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'pre_listing', Number(req.params.id), 'Deleted pre-listing')
  res.json({ success: true })
})

// Sync Potential Sellers from Google Sheet
router.post('/sync-sheet', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1628DMNtqi5_hcS4e62RTjtHjwp5i8qk4wIloFO15dug/gviz/tq?tqx=out:csv&sheet=Potential%20Sellers'
    const response = await fetch(sheetUrl)
    const csv = await response.text()
    const rows = parseCSV(csv)
    if (rows.length < 2) return res.json({ synced: 0 })

    let synced = 0
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i]
      if (!cols[0]) continue
      const existing = db.get('SELECT id FROM pre_listings WHERE property_address = ?', [cols[0]])
      if (existing) continue
      const bv = (v) => v === 'TRUE' ? 1 : 0
      db.run(`INSERT INTO pre_listings (property_address, owner_name, walkthrough, status,
        marketing_materials_sent, seller_discovery_form, cma, seller_netsheet, loop_created,
        listing_contract_signed, getting_home_ready, schedule_photoshoot, get_spare_keys,
        install_lockbox, install_signs, written_description, coming_soon_post, coming_soon_email,
        listing_submitted_mls, posted_social_media, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cols[0], n(cols[1]), n(cols[2]) || 'Not Scheduled', n(cols[3]) || 'New',
          bv(cols[4]), bv(cols[5]), bv(cols[6]), bv(cols[7]), bv(cols[8]),
          bv(cols[9]), bv(cols[10]), bv(cols[11]), bv(cols[12]), bv(cols[13]),
          bv(cols[14]), bv(cols[15]), bv(cols[16]), bv(cols[17]), bv(cols[18]),
          bv(cols[19]), n(cols[20])])
      synced++
    }
    logActivity('synced', 'pre_listing', null, `Synced ${synced} potential sellers from Google Sheet`)
    res.json({ synced })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

function parseCSV(csv) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++ }
        else inQuotes = false
      } else {
        cell += c
      }
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(cell.trim()); cell = '' }
      else if (c === '\n' || c === '\r') {
        if (cell || row.length) {
          row.push(cell.trim())
          if (row.some(v => v !== '')) rows.push(row)
          row = []
          cell = ''
        }
        if (c === '\r' && csv[i + 1] === '\n') i++
      } else {
        cell += c
      }
    }
  }
  if (cell || row.length) {
    row.push(cell.trim())
    if (row.some(v => v !== '')) rows.push(row)
  }
  return rows
}

export default router
