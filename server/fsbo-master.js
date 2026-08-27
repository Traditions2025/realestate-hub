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
  const index = new Map()      // phone10 -> best record (single-listing / attach to existing lead)
  const aindex = new Map()     // phone10|address -> record (each LISTING is its own record)
  const sheetPhones = new Set()
  const sheetAkeys = new Set()
  const normAddr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const akey = (phone, addr) => { const p = last10(phone); return p ? p + '|' + normAddr(addr) : null }
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
  const better = (c, prev) => !prev || rank(c) > rank(prev) || (rank(c) === rank(prev) && c.id < prev.id)
  for (const c of db.all("SELECT id, phone, address, tags, fsbo_status, status, first_name, last_name FROM clients WHERE phone IS NOT NULL AND phone != '' AND merged_into IS NULL")) {
    const k = last10(c.phone); if (!k) continue
    if (better(c, index.get(k))) index.set(k, c)
    const ak = akey(c.phone, c.address)
    if (ak && better(c, aindex.get(ak))) aindex.set(ak, c)
  }
  // A phone that appears on 2+ sheet rows is a multi-listing seller (e.g. a builder). Each of
  // its listings (phone+address) becomes its own record; a single-listing phone attaches to
  // the existing CRM lead by phone.
  const rowsPerPhone = {}
  for (const r of rows) { const k = last10(r.phone); if (k) rowsPerPhone[k] = (rowsPerPhone[k] || 0) + 1 }
  const createNew = (row) => {
    const { first, last } = splitName(row.name)
    const info = db.run(
      `INSERT INTO clients (first_name, last_name, phone, email, type, status, source, address, city, state, zip, tags, fsbo_status, fsbo_status_at, fsbo_list_date, fsbo_dom, fsbo_notes, fsbo_link, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [first, last, row.phone, row.email || null, 'seller', 'watch', row.source || 'FSBO Master',
       row.address || null, row.city || null, row.state || 'IA', row.zip || null, tagsJson(row.tags), row.status, now, row.list_date || null, row.dom || null, row.notes || null, row.link || null, now, now])
    report.created++
    const rec = { id: info.lastInsertRowid, phone: row.phone, address: row.address || null, tags: tagsJson(row.tags), fsbo_status: row.status, status: 'watch', first_name: first, last_name: last }
    const k = last10(row.phone); if (k) index.set(k, rec)
    const ak = akey(row.phone, row.address); if (ak) aindex.set(ak, rec)
  }
  for (const row of rows) {
    const key = last10(row.phone)
    const ak = akey(row.phone, row.address)
    if (key) sheetPhones.add(key)
    if (ak) sheetAkeys.add(ak)
    report.counts[row.status] = (report.counts[row.status] || 0) + 1
    // Multi-listing phone → match THIS listing by phone+address (each listing keeps its own
    // record). Single-listing phone → match by phone (attach the FSBO to the existing CRM lead).
    const multi = key && rowsPerPhone[key] > 1
    const match = multi ? (ak ? aindex.get(ak) : null) : (key ? index.get(key) : null)
    // Phone COLLISION: the number matches an existing DEAD lead of a clearly different name.
    // Don't stamp the FSBO onto the wrong lead — clear any wrong stamp and create the FSBO
    // its own record.
    if (match && isJunkish(match.status) && !sameName(row.name, match)) {
      db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL WHERE id=?', [match.id])
      report.collisions++
      createNew(row)
      continue
    }
    if (!match) {
      // The FSBO master file is the source of truth: create a Hub record so every FSBO listing
      // (Available AND Off Market) lands on the list. On re-sync it matches by phone/address.
      createNew(row)
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
  // Prune stragglers: a client carrying an fsbo_status whose phone is no longer in the sheet
  // is no longer an FSBO. ALSO drop a Hub-native FSBO record (source = FSBO Master, no Sierra
  // lead) whose specific listing (phone+address) is no longer in the sheet — that's a removed
  // listing for a multi-listing seller. Existing/Sierra leads are only pruned by phone, never
  // by address (their profile address may differ from the listing).
  for (const c of db.all("SELECT id, phone, address, sierra_lead_id, source FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != ''")) {
    const k = last10(c.phone)
    const hubNative = !c.sierra_lead_id && /fsbo master/i.test(c.source || '')
    const drop = !k || !sheetPhones.has(k) || (hubNative && !sheetAkeys.has(akey(c.phone, c.address)))
    if (drop) { db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL WHERE id=?', [c.id]); report.pruned++ }
  }
  // SELF-HEAL: every sync collapses any accidental TRUE duplicate — records sharing a phone
  // AND the same address (an exact copy). Different addresses on one phone are DIFFERENT
  // listings and are kept (e.g. a builder with several homes, or one owner with two listings).
  // Keep the lowest-id record; merge extra Hub-native copies into it.
  report.deduped = 0
  const byAkey = {}
  for (const c of db.all("SELECT id, phone, address, sierra_lead_id, fsbo_list_date, fsbo_dom, fsbo_notes, fsbo_link FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL AND lower(status) NOT IN ('junk','donotcontact','archived')")) {
    const ak = akey(c.phone, c.address); if (!ak) continue
    ;(byAkey[ak] = byAkey[ak] || []).push(c)
  }
  for (const ak of Object.keys(byAkey)) {
    const g = byAkey[ak]; if (g.length < 2) continue
    g.sort((a, b) => a.id - b.id)
    const canonical = g[0]
    for (const l of g.slice(1)) {
      if (l.sierra_lead_id) continue                 // distinct Sierra profile -> keep
      const set = [], val = []
      for (const f of ['fsbo_list_date', 'fsbo_dom', 'fsbo_notes', 'fsbo_link']) if (!canonical[f] && l[f]) { set.push(`${f}=?`); val.push(l[f]); canonical[f] = l[f] }
      if (set.length) { val.push(canonical.id); db.run(`UPDATE clients SET ${set.join(', ')} WHERE id=?`, val) }
      db.run("UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL, merged_into=?, updated_at=? WHERE id=?", [canonical.id, now, l.id])
      report.deduped++
    }
  }
  // How many FSBO-master clients now sit in the live FSBO list, and whether it lines up
  // with the sheet (an invariant: on-list should equal unique sheet phones + legit extras).
  report.in_list_now = db.get("SELECT COUNT(*) n FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != ''").n
  report.on_list = db.get("SELECT COUNT(*) n FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL AND lower(status) NOT IN ('junk','donotcontact','archived')").n
  report.unique_sheet_phones = sheetPhones.size
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
