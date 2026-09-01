// Expired/Cancelled master-file sync. Reads the team's Expired/Cancelled Master File (published
// as CSV), matches each row to an existing Hub client by ADDRESS + CITY (never address alone),
// confirms the sheet's Name 1 against the client, then writes off_market_date / mls_number /
// listing_agent and junks anything that has gone back on the market. Mirrors fsbo-master.js.
//
// SCOPE: this only updates EXISTING clients. Creating leads from the sheet is deliberately out
// of scope (a Hub-only lead never reaches FUB / Sierra drips) — see HUB-SYNC-BRIEF.md.
import db from './database.js'
import { parseCsv } from './fsbo-master.js'
import { stopSequencesForClient, isStopStatus } from './lead-sequences.js'

const nowIso = () => new Date().toISOString()

const DEFAULT_SHEET_ID = '1Xwsz0S2gBVTDizUweHxcO22C1xQZIHMrKlScor5N0xY'
export function expiredMasterCsvUrl() {
  const stored = db.getSetting?.('expired_master_sheet_url')
  if (stored) {
    const m = String(stored).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
    if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`
    return stored
  }
  return `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/export?format=csv`
}

// --- address / name normalization -------------------------------------------------
// Expand long street/quadrant forms as WHOLE WORDS before stripping spaces, so
// "4960 Lucore Rd" and "4960 Lucore Road" collapse to the same key.
const ADDR_WORDS = {
  ROAD: 'RD', STREET: 'ST', AVENUE: 'AVE', DRIVE: 'DR', COURT: 'CT', LANE: 'LN', CIRCLE: 'CIR',
  TRAIL: 'TRL', BOULEVARD: 'BLVD', PARKWAY: 'PKWY', TERRACE: 'TER', PLACE: 'PL',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
}
function normAddr(a) {
  let s = String(a || '').toUpperCase().trim()
  s = s.replace(/\b(ROAD|STREET|AVENUE|DRIVE|COURT|LANE|CIRCLE|TRAIL|BOULEVARD|PARKWAY|TERRACE|PLACE|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\b/g, m => ADDR_WORDS[m])
  return s.replace(/[^A-Z0-9]/g, '')
}
const normCity = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const addrCityKey = (addr, city) => { const a = normAddr(addr), c = normCity(city); return a ? `${a}|${c}` : null }

// Same party? Order-insensitive (handles "Karr, Kurt" vs "Kurt Karr"). Guards against writing a
// status onto a previous owner living at the same address.
function sameName(sheetName, c) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const a = norm(sheetName), b = norm(`${c.first_name || ''} ${c.last_name || ''}`)
  if (!a.length || !b.length) return false
  const setB = new Set(b)
  if (a.filter(t => setB.has(t)).length >= 2) return true            // share both first + last (any order)
  const lastA = a[a.length - 1], lastB = b[b.length - 1]
  if (lastA === lastB && a[0][0] === b[0][0]) return true            // same surname + first initial (Bob/Robert)
  return false
}

// Pull a date out of a free-text cell (Notes carries "As of <date>:"). Returns a Date or null.
function extractDate(s) {
  s = String(s || '')
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { let yr = Number(m[3]); if (yr < 100) yr += 2000; const d = new Date(yr, Number(m[1]) - 1, Number(m[2])); return isNaN(d.getTime()) ? null : d }
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) { const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return isNaN(d.getTime()) ? null : d }
  return null
}
const monthsAgo = (d, n) => { const c = new Date(); c.setMonth(c.getMonth() - n); return d >= c }

// Classify column P. Anything unexpected (incl. empty) is 'unknown' — never junk on unknown.
function classifyMlsStatus(p) {
  const s = String(p || '').trim().toLowerCase()
  if (!s) return 'unknown'
  if (['cancelled', 'canceled', 'expired', 'withdrawn'].includes(s)) return 'off_market'
  if (s === 'active' || s === 'pending' || s === 'active contingent' || s === 'backup' || s.startsWith('active contingent') || s.startsWith('backup')) return 'back_on_market'
  if (s === 'sold') return 'sold'
  return 'unknown'
}

// --- read the sheet ----------------------------------------------------------------
export async function fetchExpiredMasterRows() {
  const resp = await fetch(expiredMasterCsvUrl(), { headers: { 'User-Agent': 'MattSmithHub/1.0' } })
  if (!resp.ok) throw new Error(`Expired sheet fetch ${resp.status} ${resp.statusText}`)
  const rows = parseCsv(await resp.text())
  if (!rows.length) return []
  const header = rows[0].map(h => String(h || '').trim())
  const idx = (name) => header.findIndex(h => h.toLowerCase() === name.toLowerCase())
  const iName = idx('Name 1'), iAddr = idx('Street Address'), iCity = idx('City'), iState = idx('State'), iZip = idx('Zipcode')
  const iTags = idx('Tags'), iStatus = idx('Status'), iNotes = idx('Notes'), iMls = idx('MLS #'), iOff = idx('Off Market Date'), iAgent = idx('Listing Agent')
  const cell = (row, i) => i >= 0 ? String(row[i] || '').trim() : ''
  const out = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    out.push({
      name: cell(row, iName), address: cell(row, iAddr), city: cell(row, iCity), state: cell(row, iState), zip: cell(row, iZip),
      tags: cell(row, iTags), mls_status: cell(row, iStatus), notes: cell(row, iNotes),
      mls_number: cell(row, iMls), off_market_date: cell(row, iOff), listing_agent: cell(row, iAgent),
    })
  }
  return out
}

// --- the sync ----------------------------------------------------------------------
export async function syncExpiredMaster({ dryRun = false } = {}) {
  const rows = await fetchExpiredMasterRows()
  const now = nowIso()
  const report = {
    dry: !!dryRun, sheet_rows: rows.length,
    counts: { off_market: 0, back_on_market: 0, sold: 0, unknown: 0 },
    matched: 0, unmatched: 0, name_mismatch: 0, wrote: 0,
    junked: 0, already_junk: 0,
    unmatched_addresses: [], name_mismatches: [], would_junk: [], junk_new: [], junk_skipped_sold_old: [],
  }

  // Address+City index of live Hub clients (multiple people can share an address → keep a list).
  const index = new Map()
  for (const c of db.all("SELECT id, first_name, last_name, address, city, status FROM clients WHERE address IS NOT NULL AND address != '' AND merged_into IS NULL")) {
    const k = addrCityKey(c.address, c.city); if (!k) continue
    if (!index.has(k)) index.set(k, [])
    index.get(k).push(c)
  }

  for (const row of rows) {
    const cls = classifyMlsStatus(row.mls_status)
    report.counts[cls] = (report.counts[cls] || 0) + 1
    const key = addrCityKey(row.address, row.city)
    const candidates = key ? (index.get(key) || []) : []
    if (!candidates.length) { report.unmatched++; if (report.unmatched_addresses.length < 60) report.unmatched_addresses.push(`${row.address}, ${row.city} [${row.mls_status || '?'}]`); continue }
    // Confirm the sheet's Name 1 against a candidate at that address (never junk a stranger).
    const match = candidates.find(c => sameName(row.name, c))
    if (!match) { report.name_mismatch++; if (report.name_mismatches.length < 60) report.name_mismatches.push(`${row.name} @ ${row.address}, ${row.city} (Hub has: ${candidates.map(c => `${c.first_name || ''} ${c.last_name || ''}`.trim()).join(' / ')})`); continue }
    report.matched++

    // Decide junk. Sold only counts when the sale is recent (≤24 months) — an old Sold is
    // usually when the owner BOUGHT, and those leads are still workable.
    let doJunk = false, reason = ''
    if (cls === 'back_on_market') { doJunk = true; reason = `back on market (${row.mls_status})` }
    else if (cls === 'sold') {
      const d = extractDate(row.notes) || extractDate(row.off_market_date)
      if (d && monthsAgo(d, 24)) { doJunk = true; reason = `sold ${d.toISOString().slice(0, 10)} (recent)` }
      else { report.junk_skipped_sold_old.push(`${row.name} @ ${row.address} (sold ${d ? d.toISOString().slice(0, 10) : 'date unknown'})`) }
    }
    // 'off_market' and 'unknown' never junk.

    const label = `${match.first_name || ''} ${match.last_name || ''}`.trim()
    if (doJunk) {
      report.would_junk.push(`${label} — ${reason}`)
      if (isStopStatus(match.status)) report.already_junk++
      else report.junk_new.push(`${label} — ${reason}`)
    }

    if (!dryRun) {
      const sets = ['mls_extract_attempted_at=?'], vals = [now]
      if (row.off_market_date) { sets.push('off_market_date=?'); vals.push(row.off_market_date) }
      if (row.mls_number) { sets.push('mls_number=?'); vals.push(row.mls_number) }
      if (row.listing_agent) { sets.push('listing_agent=?'); vals.push(row.listing_agent) }
      if (doJunk && !isStopStatus(match.status)) {
        sets.push('status=?'); vals.push('junk')
      }
      db.run(`UPDATE clients SET ${sets.join(', ')}, updated_at=? WHERE id=?`, [...vals, now, match.id])
      report.wrote++
      if (doJunk && !isStopStatus(match.status)) { try { stopSequencesForClient(match.id, `expired master: ${reason}`) } catch {} report.junked++ }
    }
  }
  report.match_rate_pct = report.sheet_rows ? Math.round((report.matched / report.sheet_rows) * 100) : 0
  if (!dryRun) db.setSetting?.('expired_master_last_sync', now)
  return report
}

// The Cancelled/Expired list (id 1) is a DYNAMIC filter on status (new/qualify/watch) + the
// MLS: Cancelled/Expired tags. Junking a lead drops it out automatically, so list membership
// stays honest with no repointing needed. This just reports the list for parity with FSBO.
export function ensureExpiredListIncludesMaster() {
  const list = db.get("SELECT id, name FROM client_lists WHERE lower(name) LIKE 'cancelled%' OR lower(name) LIKE '%expired%' ORDER BY id LIMIT 1")
  return list
    ? { ok: true, list_id: list.id, name: list.name, note: 'dynamic status+tag filter; junk removes leads automatically' }
    : { ok: false, reason: 'no Cancelled/Expired list found' }
}
