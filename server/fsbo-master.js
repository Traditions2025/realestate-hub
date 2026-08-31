// FSBO master-file sync. Reads the team's FSBO master Google Sheet (published as CSV),
// matches each row to a Hub client by phone (last 10 digits), and writes the sheet's
// "FSBO Status" (Available | Off Market) onto the client. This drives the Hub FSBO list
// and its FSBO-Status column. Read-only against the sheet; upserts only fsbo_status.
import db from './database.js'
import { stopSequencesForClient } from './lead-sequences.js'

const nowIso = () => new Date().toISOString()

// The sheet's DOM column is a stale snapshot (frozen whenever the row was last touched), so it
// drifts days/weeks behind reality. List Date is reliable, so we compute DOM = today - List Date
// and let the daily sync keep it current. Falls back to the sheet's DOM only if List Date is missing.
function parseSheetDate(s) {
  s = String(s || '').trim(); if (!s) return null
  let m
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    let yr = Number(m[3]); if (yr < 100) yr += 2000
    const dt = new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2]))); return isNaN(dt.getTime()) ? null : dt
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))); return isNaN(dt.getTime()) ? null : dt
  }
  const dt = new Date(s); return isNaN(dt.getTime()) ? null : dt
}
function computeDom(listDate, sheetDom) {
  const d = parseSheetDate(listDate)
  if (d) return String(Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)))
  const n = String(sheetDom || '').trim()
  return n || null
}

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

// Normalize an "FSBO Status" cell to a canonical value or null. Three real values:
//   Available   — still for sale FSBO → active list + text sequence
//   Pending     — under contract / spoken for → dead lead → Junk, off the list
//   Off Market  — withdrawn / expired, did NOT sell → stays on list (labeled), not texted
// Pending and Off Market are DIFFERENT: only Pending is junked.
function normStatus(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return null
  if (s.startsWith('avail')) return 'Available'
  if (s.startsWith('pend') || s.includes('contract')) return 'Pending'
  if (s.startsWith('off') || s.startsWith('withdraw') || s.startsWith('expire')) return 'Off Market'
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
  const index = new Map()      // phone10 -> best existing record to attach the FSBO to
  const sheetPhones = new Set()
  const normAddr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  // Rank a candidate for the phone index. A LIVE (non-junk) record already carrying an
  // fsbo_status always wins — even over an older JUNK lead with a legacy "FSBO" tag.
  const rank = (x) => {
    const junk = isJunkish(x.status)
    const hasFsbo = !!(x.fsbo_status && String(x.fsbo_status).trim())
    if (hasFsbo && !junk) return 4
    if (hasFsbo && junk) return 3
    if (!junk && /fsbo/i.test(x.tags || '')) return 2
    if (!junk) return 1
    return 0
  }
  const better = (c, prev) => !prev || rank(c) > rank(prev) || (rank(c) === rank(prev) && c.id < prev.id)
  for (const c of db.all("SELECT id, phone, tags, fsbo_status, status, first_name, last_name FROM clients WHERE phone IS NOT NULL AND phone != '' AND merged_into IS NULL")) {
    const k = last10(c.phone); if (!k) continue
    if (better(c, index.get(k))) index.set(k, c)
  }
  // ONE profile per (name + phone). A seller with several listings on the same number is a
  // single lead; every listing (address / link / list date / DOM / status) is stored on it in
  // fsbo_listings. Group the sheet rows accordingly.
  const groups = new Map()
  for (const row of rows) {
    const k = last10(row.phone)
    const gk = k ? k + '|' + normName(row.name) : ('nophone|' + normName(row.name) + '|' + groups.size)
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk).push(row)
  }
  report.profiles = groups.size
  const buildListings = (grp) => grp.map(r => ({ address: r.address || null, city: r.city || null, list_date: r.list_date || null, dom: computeDom(r.list_date, r.dom), status: r.status || null, link: r.link || null, notes: r.notes || null }))
  const createNew = (primary, status, listingsJson) => {
    const { first, last } = splitName(primary.name)
    const info = db.run(
      `INSERT INTO clients (first_name, last_name, phone, email, type, status, source, address, city, state, zip, tags, fsbo_status, fsbo_status_at, fsbo_list_date, fsbo_dom, fsbo_notes, fsbo_link, fsbo_listings, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [first, last, primary.phone, primary.email || null, 'seller', 'watch', primary.source || 'FSBO Master',
       primary.address || null, primary.city || null, primary.state || 'IA', primary.zip || null, tagsJson(primary.tags), status, now, primary.list_date || null, computeDom(primary.list_date, primary.dom), primary.notes || null, primary.link || null, listingsJson, now, now])
    report.created++
    const rec = { id: info.lastInsertRowid, phone: primary.phone, tags: tagsJson(primary.tags), fsbo_status: status, status: 'watch', first_name: first, last_name: last }
    const k = last10(primary.phone); if (k) index.set(k, rec)
  }
  for (const grp of groups.values()) {
    const primary = grp.find(r => r.status === 'Available') || grp.find(r => r.status === 'Pending') || grp[0]
    const key = last10(primary.phone)
    if (key) sheetPhones.add(key)
    // Aggregate status across a seller's listings: Available wins (still has something for
    // sale), else Pending (under contract), else Off Market.
    const status = grp.some(r => r.status === 'Available') ? 'Available'
      : grp.some(r => r.status === 'Pending') ? 'Pending' : 'Off Market'
    report.counts[status] = (report.counts[status] || 0) + 1
    const listingsJson = JSON.stringify(buildListings(grp))
    const match = key ? index.get(key) : null
    // Phone COLLISION: number matches a DEAD lead of a clearly different name — don't stamp the
    // FSBO onto the wrong lead; give it its own record.
    if (match && isJunkish(match.status) && !sameName(primary.name, match)) {
      db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL, fsbo_listings=NULL WHERE id=?', [match.id])
      report.collisions++
      createNew(primary, status, listingsJson)
      continue
    }
    if (!match) { createNew(primary, status, listingsJson); continue }
    report.matched++
    db.run('UPDATE clients SET fsbo_status=?, fsbo_status_at=?, fsbo_list_date=?, fsbo_dom=?, fsbo_notes=?, fsbo_link=?, fsbo_listings=?, updated_at=? WHERE id=?',
      [status, now, primary.list_date || null, computeDom(primary.list_date, primary.dom), primary.notes || null, primary.link || null, listingsJson, now, match.id])
    match.fsbo_status = status
  }
  // Prune stragglers: an fsbo_status record whose phone is no longer in the sheet.
  for (const c of db.all("SELECT id, phone FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != ''")) {
    const k = last10(c.phone)
    if (!k || !sheetPhones.has(k)) { db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL, fsbo_listings=NULL WHERE id=?', [c.id]); report.pruned++ }
  }
  // SELF-HEAL: collapse ANY remaining records that share the same name + phone into ONE profile,
  // combining all their listings. This makes multi-listing sellers (and any accidental dup) a
  // single lead — even across separate Sierra profiles. Keep the lowest-id record.
  report.deduped = 0
  const byKey = {}
  for (const c of db.all("SELECT id, phone, first_name, last_name, fsbo_listings, fsbo_status FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL AND lower(status) NOT IN ('junk','donotcontact','archived')")) {
    const k = last10(c.phone); if (!k) continue
    const gk = k + '|' + normName(`${c.first_name || ''} ${c.last_name || ''}`)
    ;(byKey[gk] = byKey[gk] || []).push(c)
  }
  for (const gk of Object.keys(byKey)) {
    const g = byKey[gk]; if (g.length < 2) continue
    g.sort((a, b) => a.id - b.id)
    const canonical = g[0]
    let combined = []
    try { combined = JSON.parse(canonical.fsbo_listings || '[]') } catch {}
    const seen = new Set(combined.map(x => normAddr(x.address)))
    for (const l of g.slice(1)) {
      let ll = []; try { ll = JSON.parse(l.fsbo_listings || '[]') } catch {}
      for (const x of ll) { const a = normAddr(x.address); if (!seen.has(a)) { combined.push(x); seen.add(a) } }
      db.run("UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL, fsbo_listings=NULL, merged_into=?, updated_at=? WHERE id=?", [canonical.id, now, l.id])
      report.deduped++
    }
    const anyAvail = combined.some(x => String(x.status || '').toLowerCase() === 'available')
    const prim = combined.find(x => String(x.status || '').toLowerCase() === 'available') || combined[0] || {}
    db.run("UPDATE clients SET fsbo_listings=?, fsbo_status=?, address=COALESCE(?,address), fsbo_link=COALESCE(?,fsbo_link), updated_at=? WHERE id=?",
      [JSON.stringify(combined), anyAvail ? 'Available' : (canonical.fsbo_status || 'Off Market'), prim.address || null, prim.link || null, now, canonical.id])
  }
  // ONE-TIME correction: an earlier rule wrongly junked Off Market FSBOs. Off Market is NOT
  // Pending — those sellers stay on the list. Restore any Off Market lead still sitting in Junk
  // back to 'watch'. Self-disables after the first run so it never un-junks a later legit junk.
  if (db.getSetting?.('fsbo_offmarket_unjunk_done', '0') !== '1') {
    const r = db.run("UPDATE clients SET status='watch', updated_at=? WHERE fsbo_status='Off Market' AND lower(status)='junk'", [now])
    report.offmarket_restored = r.changes || 0
    db.setSetting?.('fsbo_offmarket_unjunk_done', '1')
  }
  // TEAM RULE: a FSBO that has gone PENDING (under contract) is a dead lead — it drops OFF the
  // active list and is moved to Junk, pulled out of every sequence. We keep fsbo_status =
  // 'Pending' as the record of WHY it left. Off Market (withdrawn/expired, did NOT sell) is
  // DIFFERENT: those stay on the list, labeled, and are simply not texted.
  report.junked_pending = 0
  for (const c of db.all("SELECT id, status FROM clients WHERE fsbo_status='Pending' AND merged_into IS NULL")) {
    if (isJunkish(c.status)) continue
    db.run("UPDATE clients SET status='junk', updated_at=? WHERE id=?", [now, c.id])
    try { stopSequencesForClient(c.id, 'FSBO went Pending (under contract)') } catch {}
    report.junked_pending++
  }
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
  // FSBO list = Available + Off Market from the master file (Off Market stays, labeled).
  // Pending (under contract) is junked and intentionally NOT shown here.
  const want = ['Available', 'Off Market']
  const inc = Array.isArray(cur?.fsbo_statuses_include) ? cur.fsbo_statuses_include : null
  const already = cur && cur.has_fsbo_status && inc && inc.length === want.length && want.every(w => inc.includes(w))
  if (already) return { ok: true, already: true, list_id: list.id }
  const next = { has_fsbo_status: 1, fsbo_statuses_include: want, _legacy: cur._legacy || cur }
  db.run("UPDATE client_lists SET filter_criteria=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(next), list.id])
  return { ok: true, list_id: list.id }
}
