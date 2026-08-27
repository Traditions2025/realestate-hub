// FSBO master-file sync. Reads the team's FSBO master Google Sheet (published as CSV),
// matches each row to a Hub client by phone (last 10 digits), and writes the sheet's
// "FSBO Status" (Available | Off Market) onto the client. This drives the Hub FSBO list
// and its FSBO-Status column. Read-only against the sheet; upserts only fsbo_status.
import db from './database.js'

const nowIso = () => new Date().toISOString()

// Default to the team's shared FSBO master sheet; override via app_settings.
const DEFAULT_SHEET_ID = '1i0p9ux3_4pluE24ioBajqTBZ2SqFkM6qtu7pofDDaJc'
export function fsboMasterCsvUrl() {
  const stored = db.getSetting?.('fsbo_master_sheet_url')
  if (stored) {
    // Accept either a full edit URL or a direct CSV URL; normalize an edit URL to export.
    const m = String(stored).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
    if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`
    return stored
  }
  return `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/export?format=csv`
}

const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null }

// Minimal RFC-4180 CSV parser (handles quoted fields with embedded commas/newlines).
export function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

// Normalize an "FSBO Status" cell to a canonical value or null.
function normStatus(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return null
  if (s.startsWith('avail')) return 'Available'
  if (s.startsWith('off')) return 'Off Market'
  return null
}

export async function fetchFsboMasterRows() {
  const url = fsboMasterCsvUrl()
  const resp = await fetch(url, { headers: { 'User-Agent': 'MattSmithHub/1.0' } })
  if (!resp.ok) throw new Error(`FSBO sheet fetch ${resp.status} ${resp.statusText}`)
  const text = await resp.text()
  const rows = parseCsv(text)
  if (!rows.length) return []
  const header = rows[0].map(h => String(h || '').trim())
  const idx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase())
  const iPhone = idx('Phone 1'), iStatus = idx('FSBO Status'), iName = idx('Name'), iAddr = idx('Street Address')
  const iCity = idx('City'), iState = idx('State'), iZip = idx('Zipcode'), iEmail = idx('Email'), iSource = idx('Source'), iTags = idx('Tags')
  const iListDate = idx('List Date'), iDom = idx('DOM'), iNotes = idx('Notes'), iLink = idx('Custom Link')
  const cell = (row, i) => i >= 0 ? String(row[i] || '').trim() : ''
  const out = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const phone = cell(row, iPhone)
    const status = normStatus(cell(row, iStatus))
    if (!last10(phone) || !status) continue
    out.push({
      phone, status,
      name: cell(row, iName), address: cell(row, iAddr), city: cell(row, iCity),
      state: cell(row, iState) || 'IA', zip: cell(row, iZip), email: cell(row, iEmail),
      source: cell(row, iSource), tags: cell(row, iTags),
      list_date: cell(row, iListDate), dom: cell(row, iDom),
      notes: cell(row, iNotes), link: cell(row, iLink),
    })
  }
  return out
}

// Split a sheet "Name" (person, trust, or company) into first/last, never blank.
function splitName(name) {
  const s = String(name || '').trim()
  if (!s) return { first: 'FSBO', last: '(no name)' }
  const parts = s.split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '(FSBO)' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

// Master "FSBO NEW,FSBO ACTIVE" -> JSON tags array (from the sheet's own tags).
function tagsJson(raw) {
  const t = String(raw || '').split(',').map(x => x.trim()).filter(Boolean)
  return JSON.stringify(t)
}

// Do the sheet FSBO name and an existing Hub lead look like the SAME party? Guards against
// phone collisions (two different people/companies sharing a number).
function sameName(sheetName, c) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const a = norm(sheetName), b = norm(`${c.first_name || ''} ${c.last_name || ''}`)
  if (!a.length || !b.length) return false
  if (a.join(' ') === b.join(' ')) return true
  return a[a.length - 1] === b[b.length - 1] && a[0] === b[0]   // same first + last token
}
const isJunkish = (status) => ['junk', 'donotcontact', 'archived', 'closed'].includes(String(status || '').toLowerCase())

// Sync the sheet onto clients. Returns a reconciliation report.
export async function syncFsboMaster() {
  const rows = await fetchFsboMasterRows()
  const report = { sheet_rows: rows.length, matched: 0, updated: 0, created: 0, collisions: 0, pruned: 0, in_list_now: 0, unmatched: [], counts: { Available: 0, 'Off Market': 0 } }
  const now = nowIso()
  // Phones in the DB are stored formatted ("(319) 531-0905"), so a raw-digit LIKE never
  // matches. Build a normalized last-10 -> client index once. On a shared number, prefer
  // an FSBO-tagged client, else the lowest id.
  const index = new Map()
  const sheetPhones = new Set()
  // Rank a candidate for the phone index. A LIVE (non-junk) record already carrying an
  // fsbo_status is the real FSBO and must always win — even over an older JUNK lead that
  // happens to carry a legacy "FSBO" tag. Anchoring on such a junk lead makes the collision
  // branch fire on every sync and create a fresh duplicate each time.
  const rank = (x) => {
    const junk = isJunkish(x.status)
    const hasFsbo = !!(x.fsbo_status && String(x.fsbo_status).trim())
    if (hasFsbo && !junk) return 4        // the live FSBO record — always preferred
    if (hasFsbo && junk) return 3
    if (!junk && /fsbo/i.test(x.tags || '')) return 2
    if (!junk) return 1
    return 0                              // junkish, no fsbo_status (tag ignored)
  }
  for (const c of db.all("SELECT id, phone, tags, fsbo_status, status, first_name, last_name FROM clients WHERE phone IS NOT NULL AND phone != '' AND merged_into IS NULL")) {
    const k = last10(c.phone); if (!k) continue
    const prev = index.get(k)
    if (!prev) { index.set(k, c); continue }
    const rc = rank(c), rp = rank(prev)
    if (rc > rp || (rc === rp && c.id < prev.id)) index.set(k, c)
  }
  const createNew = (row, key) => {
    const { first, last } = splitName(row.name)
    const info = db.run(
      `INSERT INTO clients (first_name, last_name, phone, email, type, status, source, address, city, state, zip, tags, fsbo_status, fsbo_status_at, fsbo_list_date, fsbo_dom, fsbo_notes, fsbo_link, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [first, last, row.phone, row.email || null, 'seller', 'watch', row.source || 'FSBO Master',
       row.address || null, row.city || null, row.state || 'IA', row.zip || null, tagsJson(row.tags), row.status, now, row.list_date || null, row.dom || null, row.notes || null, row.link || null, now, now])
    report.created++
    if (key) index.set(key, { id: info.lastInsertRowid, phone: row.phone, tags: tagsJson(row.tags), fsbo_status: row.status, status: 'watch', first_name: first, last_name: last })
  }
  for (const row of rows) {
    const key = last10(row.phone)
    if (key) sheetPhones.add(key)
    report.counts[row.status] = (report.counts[row.status] || 0) + 1
    const match = key ? index.get(key) : null
    // Phone COLLISION: the number matches an existing DEAD lead of a clearly different name.
    // Don't stamp the FSBO onto the wrong lead — clear any wrong stamp and create the FSBO
    // its own record.
    if (match && isJunkish(match.status) && !sameName(row.name, match)) {
      db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL WHERE id=?', [match.id])
      report.collisions++
      createNew(row, key)
      continue
    }
    if (!match) {
      // The FSBO master file is the source of truth: create a Hub record so every FSBO
      // (Available AND Off Market) lands on the list. On re-sync it matches by phone.
      createNew(row, key)
      continue
    }
    report.matched++
    if (match.fsbo_status !== row.status) {
      db.run('UPDATE clients SET fsbo_status=?, fsbo_status_at=?, fsbo_list_date=?, fsbo_dom=?, fsbo_notes=?, fsbo_link=?, updated_at=? WHERE id=?', [row.status, now, row.list_date || null, row.dom || null, row.notes || null, row.link || null, now, match.id])
      report.updated++
    } else {
      db.run('UPDATE clients SET fsbo_status_at=?, fsbo_list_date=?, fsbo_dom=?, fsbo_notes=?, fsbo_link=? WHERE id=?', [now, row.list_date || null, row.dom || null, row.notes || null, row.link || null, match.id])
    }
    match.fsbo_status = row.status
  }
  // Prune stragglers: a client carrying an fsbo_status whose phone is no longer in the
  // sheet is no longer an FSBO (the master file is the source of truth). Clear the FSBO
  // fields so they drop off the list. Their lead status (e.g. junk) is left untouched.
  for (const c of db.all("SELECT id, phone FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != ''")) {
    const k = last10(c.phone)
    if (!k || !sheetPhones.has(k)) { db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL WHERE id=?', [c.id]); report.pruned++ }
  }
  // How many FSBO-master clients now sit in the live FSBO list (fsbo_status set).
  report.in_list_now = db.get("SELECT COUNT(*) n FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != ''").n
  db.setSetting?.('fsbo_master_last_sync', now)
  return report
}

// Point the saved "FSBO" client_list at the master file: its members are exactly the
// clients that carry an fsbo_status (Available / Off Market) from the sheet. This
// guarantees "all available and off market are in the FSBO list" and keeps the list a
// legacy flat filter so the Clients page renders it normally. The prior tag+status
// criteria is preserved under _legacy for easy revert. Idempotent.
export function ensureFsboListIncludesMaster() {
  const list = db.get("SELECT id, filter_criteria FROM client_lists WHERE lower(name)='fsbo' ORDER BY id LIMIT 1")
  if (!list) return { ok: false, reason: 'no FSBO list found' }
  let cur = {}
  try { cur = JSON.parse(list.filter_criteria || '{}') } catch {}
  // Members: EVERY record carrying an fsbo_status — Available AND Off Market — so the list
  // mirrors the master file 1:1. Merged duplicates have their fsbo_status cleared, so they
  // drop out; nothing is excluded by lead status (Off Market stays on the list).
  if (cur && cur.has_fsbo_status && !cur.statuses_exclude) return { ok: true, already: true, list_id: list.id }
  const next = { has_fsbo_status: 1, _legacy: cur._legacy || cur }
  db.run("UPDATE client_lists SET filter_criteria=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(next), list.id])
  return { ok: true, list_id: list.id }
}
