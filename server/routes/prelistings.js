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

// Restrict :id to digits so static-named routes like /diagnostics aren't
// swallowed by this matcher.
router.get('/:id(\\d+)', (req, res) => {
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

// Normalize an address for fuzzy-dedup matching. Strips punctuation, lowercases,
// collapses whitespace, and abbreviates common street suffix words. Catches:
//   "230 Bever Ln SE, Cedar Rapids, IA 52403"
//   "230 bever lane se, Cedar Rapids, IA 52403"
//   "230 Bever Ln SE Cedar Rapids IA 52403"
//   → all reduce to "230 bever ln se cedar rapids ia 52403"
function normalizeAddress(s) {
  if (!s) return ''
  return String(s)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bcircle\b/g, 'cir')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bparkway\b/g, 'pkwy')
    .replace(/\bnortheast\b/g, 'ne')
    .replace(/\bnorthwest\b/g, 'nw')
    .replace(/\bsoutheast\b/g, 'se')
    .replace(/\bsouthwest\b/g, 'sw')
    .trim()
}

// =============================================================
// DIAGNOSTICS — find pre-listings that should be Listed (matching a live
// transaction or listing) AND find duplicate pre-listing rows. Read-only;
// returns groups for review in the UI before any cleanup runs.
// =============================================================
router.get('/diagnostics', (_req, res) => {
  try {
    const HIDDEN = new Set(['Listed', 'Withdrawn', 'Cancelled'])
    const LIVE_TX = ['Active', 'Coming Soon', 'Under Contract', 'Pending', 'Clear to Close', 'Closed']
    const placeholders = LIVE_TX.map(() => '?').join(',')

    const activeTx = db.all(
      `SELECT id, property_address, property_status FROM transactions WHERE property_status IN (${placeholders})`,
      LIVE_TX)
    const allListings = db.all('SELECT id, property_address FROM listings')
    const pls = db.all('SELECT id, property_address, owner_name, status, updated_at, created_at FROM pre_listings')

    // Map normalized addr -> reason (tx or listing) for the should-be-listed check
    const liveIndex = new Map()
    for (const r of activeTx) {
      const k = normalizeAddress(r.property_address)
      if (k) liveIndex.set(k, { kind: 'transaction', id: r.id, status: r.property_status })
    }
    for (const r of allListings) {
      const k = normalizeAddress(r.property_address)
      if (k && !liveIndex.has(k)) liveIndex.set(k, { kind: 'listing', id: r.id })
    }

    // shouldBeListed: PLs that are still active in the UI but match a live tx/listing
    const shouldBeListed = []
    for (const pl of pls) {
      if (HIDDEN.has(pl.status)) continue
      const k = normalizeAddress(pl.property_address)
      const match = liveIndex.get(k)
      if (match) shouldBeListed.push({ ...pl, matched_with: match })
    }

    // duplicates: groups of PLs with same normalized addr (only groups of 2+)
    // Includes hidden rows too, since "Listed" + active duplicate is still confusing.
    const byAddr = new Map()
    for (const pl of pls) {
      const k = normalizeAddress(pl.property_address)
      if (!k) continue
      if (!byAddr.has(k)) byAddr.set(k, [])
      byAddr.get(k).push(pl)
    }
    const duplicates = []
    for (const [k, group] of byAddr) {
      if (group.length < 2) continue
      group.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      duplicates.push({ normalized: k, rows: group })
    }

    res.json({ shouldBeListed, duplicates, summary: {
      shouldBeListedCount: shouldBeListed.length,
      duplicateGroups: duplicates.length,
      duplicateRows: duplicates.reduce((s, g) => s + g.rows.length, 0),
    }})
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// =============================================================
// CLEANUP — body { action: 'flipToListed' | 'mergeDuplicates' | 'both' }
// flipToListed:    sets status='Listed' for every PL matching a live tx/listing
// mergeDuplicates: in each duplicate group, keeps the newest row and DELETES
//                  the rest (per user direction — no Withdrawn tagging)
// =============================================================
router.post('/cleanup', (req, res) => {
  try {
    const action = (req.body && req.body.action) || 'both'
    const wantFlip = action === 'flipToListed' || action === 'both'
    const wantMerge = action === 'mergeDuplicates' || action === 'both'

    let flippedCount = 0
    let deletedCount = 0
    const flippedIds = []
    const deletedIds = []

    if (wantFlip) {
      const LIVE_TX = ['Active', 'Coming Soon', 'Under Contract', 'Pending', 'Clear to Close', 'Closed']
      const placeholders = LIVE_TX.map(() => '?').join(',')
      const liveAddrs = new Set()
      for (const r of db.all(
        `SELECT property_address FROM transactions WHERE property_status IN (${placeholders})`,
        LIVE_TX)) {
        liveAddrs.add(normalizeAddress(r.property_address))
      }
      for (const r of db.all('SELECT property_address FROM listings')) {
        liveAddrs.add(normalizeAddress(r.property_address))
      }
      const HIDDEN = new Set(['Listed', 'Withdrawn', 'Cancelled'])
      for (const pl of db.all('SELECT id, property_address, status FROM pre_listings')) {
        if (HIDDEN.has(pl.status)) continue
        if (liveAddrs.has(normalizeAddress(pl.property_address))) {
          db.run("UPDATE pre_listings SET status = 'Listed', updated_at = datetime('now') WHERE id = ?", [pl.id])
          flippedCount++
          flippedIds.push(pl.id)
        }
      }
    }

    if (wantMerge) {
      const byAddr = new Map()
      for (const pl of db.all('SELECT id, property_address, status, updated_at FROM pre_listings')) {
        const k = normalizeAddress(pl.property_address)
        if (!k) continue
        if (!byAddr.has(k)) byAddr.set(k, [])
        byAddr.get(k).push(pl)
      }
      for (const [, group] of byAddr) {
        if (group.length < 2) continue
        group.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
        const [, ...rest] = group
        for (const pl of rest) {
          db.run('DELETE FROM pre_listings WHERE id = ?', [pl.id])
          deletedCount++
          deletedIds.push(pl.id)
        }
      }
    }

    logActivity('cleanup', 'pre_listing', null,
      `Cleanup: flipped ${flippedCount} to Listed, deleted ${deletedCount} duplicate row(s)`)
    res.json({ flippedCount, deletedCount, flippedIds, deletedIds })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DISABLED 2026-05-14. The hub is the master file for pre-listings; we do
// not pull from the Google Sheet anymore. Per user direction (and yes, the
// dedup logic was already in place — but the user has stated the hub is the
// source of truth and the sheet sync should not run at all).
router.post('/sync-sheet', (req, res) => {
  res.status(410).json({
    error: 'Google Sheet sync is disabled. The hub is the master file for pre-listings.',
    disabled_at: '2026-05-14',
  })
})

// eslint-disable-next-line no-unused-vars
async function _disabled_syncPreListingsFromSheet(req, res) {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1628DMNtqi5_hcS4e62RTjtHjwp5i8qk4wIloFO15dug/gviz/tq?tqx=out:csv&sheet=Potential%20Sellers'
    const response = await fetch(sheetUrl)
    const csv = await response.text()
    const rows = parseCSV(csv)
    if (rows.length < 2) return res.json({ synced: 0 })

    // Pre-load existing pre-listings + active listings + transactions into a
    // normalized-address index so the dedup catches "Bever Ln" vs "bever lane",
    // "3822 Banar Ave SW, Cedar Rapids" vs "3822 Banar Ave SW Cedar Rapids",
    // etc. Also skips any sheet row whose address is already a Listing or an
    // active Transaction (they're past the pre-listing stage).
    const existingPL = db.all('SELECT id, property_address FROM pre_listings')
    const existingListings = db.all('SELECT property_address FROM listings')
    const activeStatuses = ['Active', 'Under Contract', 'Pending', 'Clear to Close']
    const placeholders = activeStatuses.map(() => '?').join(',')
    const activeTx = db.all(
      `SELECT property_address FROM transactions WHERE property_status IN (${placeholders})`,
      activeStatuses)

    const skipSet = new Set()
    for (const r of existingListings) skipSet.add(normalizeAddress(r.property_address))
    for (const r of activeTx) skipSet.add(normalizeAddress(r.property_address))
    const plIndex = new Map()  // normalized addr → existing pl id
    for (const r of existingPL) plIndex.set(normalizeAddress(r.property_address), r.id)

    let synced = 0
    let skipped = 0
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i]
      if (!cols[0]) continue
      const norm = normalizeAddress(cols[0])
      if (skipSet.has(norm)) { skipped++; continue }   // already a listing/active tx
      if (plIndex.has(norm)) { skipped++; continue }   // already a pre-listing (any variant)

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
      plIndex.set(norm, true)  // prevent the same address appearing twice in one sheet
      synced++
    }
    logActivity('synced', 'pre_listing', null, `Synced ${synced} potential sellers from Google Sheet (${skipped} skipped: already exist)`)
    res.json({ synced, skipped })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}  // end _disabled_syncPreListingsFromSheet

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
