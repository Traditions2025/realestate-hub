// Background scheduler - auto-syncs data without user clicks
import db from './database.js'
import { processLead, sierraGet } from './sierra-helper.js'

const n = (v) => v === undefined || v === '' ? null : v

// Convert SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or any ISO string to Sierra-friendly UTC ISO with Z
function toSierraDate(input) {
  if (!input) return null
  let d
  if (input instanceof Date) d = input
  else if (typeof input === 'string') {
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC but lacks the Z marker.
    // Adding " UTC" makes JS parse it correctly without local-tz drift.
    d = input.includes('T') ? new Date(input) : new Date(input + ' UTC')
  } else {
    d = new Date(input)
  }
  if (isNaN(d.getTime())) return null
  // Sierra accepts ISO 8601 with Z timezone marker — drop milliseconds for cleanliness
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// Incremental Sierra sync - only leads updated since last sync
async function syncSierraIncremental() {
  try {
    const last = db.get("SELECT synced_at FROM sierra_sync_log WHERE sync_type = 'incremental' AND (errors IS NULL OR errors = '') ORDER BY synced_at DESC LIMIT 1")
    // Determine "since" — last successful incremental, or last full sync, or 1 day ago
    let sinceRaw
    if (last) sinceRaw = last.synced_at
    else {
      const lastFull = db.get("SELECT synced_at FROM sierra_sync_log WHERE sync_type NOT IN ('incremental','incremental_error','sync_error') AND (errors IS NULL OR errors = '') ORDER BY synced_at DESC LIMIT 1")
      sinceRaw = lastFull ? lastFull.synced_at : new Date(Date.now() - 24 * 60 * 60 * 1000)
    }
    let sinceDate = toSierraDate(sinceRaw)
    // Cap "since" to 7 days max — Sierra may reject very old dates and there's no point pulling > 7d incrementally
    const sevenDaysAgo = toSierraDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    if (sinceDate && sinceDate < sevenDaysAgo) sinceDate = sevenDaysAgo
    if (!sinceDate) sinceDate = sevenDaysAgo
    const sinceFormatted = sinceDate

    let added = 0, updated = 0, total = 0
    let page = 1
    let hasMore = true

    while (hasMore) {
      const result = await sierraGet('/leads/find', {
        leadUpdateDateFrom: sinceFormatted,
        includeSavedSearches: 'true',
        includeTags: 'true',
        pageSize: 100,
        pageNumber: page,
      })

      const responseData = result.data || result
      const leads = responseData.leads || []
      if (!leads.length) break

      for (const lead of leads) {
        const r = processLead(lead)
        if (r === 'added') added++
        else if (r === 'updated') updated++
        if (r) total++
      }

      const totalPages = responseData.totalPages || 1
      if (page >= totalPages) hasMore = false
      else page++
      if (page > 50) break
    }

    db.run('INSERT INTO sierra_sync_log (sync_type, leads_synced, leads_added, leads_updated) VALUES (?,?,?,?)',
      ['incremental', total, added, updated])

    if (total > 0) {
      console.log(`[scheduler] Sierra incremental: ${total} leads (${added} new, ${updated} updated)`)
    }
    return { success: true, total, added, updated, since: sinceFormatted }
  } catch (err) {
    console.error('[scheduler] Sierra sync error:', err.message)
    db.run('INSERT INTO sierra_sync_log (sync_type, errors) VALUES (?,?)', ['incremental_error', err.message])
    return { success: false, error: err.message }
  }
}

// =============================================================
// CALENDAR (iCal feeds)
// =============================================================

function parseICal(ics) {
  const events = []
  const lines = ics.replace(/\r\n[ \t]/g, '').split(/\r?\n/)
  let current = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = {}
    else if (line === 'END:VEVENT') {
      if (current) events.push(current)
      current = null
    } else if (current) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const keyPart = line.substring(0, colonIdx)
      const value = line.substring(colonIdx + 1).replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
      const key = keyPart.split(';')[0].toUpperCase()
      if (key === 'SUMMARY') current.summary = value
      else if (key === 'DESCRIPTION') current.description = value
      else if (key === 'LOCATION') current.location = value
      else if (key === 'UID') current.uid = value
      else if (key === 'DTSTART') current.start = value
      else if (key === 'DTEND') current.end = value
      else if (key === 'STATUS') current.status = value
    }
  }
  return events
}

function parseICalDate(s) {
  if (!s) return null
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/)
  if (!m) return null
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: m[4] ? `${m[4]}:${m[5]}` : null,
  }
}

function guessEventType(title) {
  const t = (title || '').toLowerCase()
  if (t.includes('showing') || t.includes('show home') || t.includes('appointment with')) return 'Showing'
  if (t.includes('closing') && !t.includes('next steps')) return 'Closing'
  if (t.includes('inspection')) return 'Inspection'
  if (t.includes('walkthrough')) return 'Walkthrough'
  if (t.includes('open house')) return 'Open House'
  if (t.includes('appraisal')) return 'Appraisal'
  if (t.includes('listing appointment')) return 'Listing Appointment'
  if (t.includes('training') || t.includes('summit') || t.includes('webinar')) return 'Training'
  if (t.includes('meeting') || t.includes('huddle')) return 'Team Meeting'
  if (t.includes('marketing') || t.includes('promotion')) return 'Marketing'
  return 'Other'
}

function colorForEventType(type) {
  return {
    'Showing': 'blue', 'Closing': 'green', 'Inspection': 'red',
    'Walkthrough': 'purple', 'Open House': 'amber', 'Appraisal': 'amber',
    'Listing Appointment': 'green', 'Training': 'blue',
    'Team Meeting': 'teal', 'Marketing': 'pink', 'Personal': 'teal',
    'Other': 'blue',
  }[type] || 'blue'
}

async function syncOneCalendar(url, label) {
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`iCal fetch ${resp.status}`)
    const ics = await resp.text()
    const events = parseICal(ics)

    let added = 0, updated = 0
    const today = new Date()
    const oneMonthAgo = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const oneYearAhead = new Date(today.getFullYear(), today.getMonth() + 12, 1)

    for (const ev of events) {
      if (!ev.summary || !ev.start) continue
      const startInfo = parseICalDate(ev.start)
      if (!startInfo) continue
      const startDate = new Date(startInfo.date)
      if (startDate < oneMonthAgo || startDate > oneYearAhead) continue

      const endInfo = parseICalDate(ev.end)
      const eventType = guessEventType(ev.summary)
      const color = colorForEventType(eventType)
      const uniqueId = ev.uid ? `${label}:${ev.uid}` : null

      const existing = uniqueId ? db.get('SELECT id FROM calendar_events WHERE google_event_id = ?', [uniqueId]) : null

      if (existing) {
        db.run(`UPDATE calendar_events SET title=?, event_type=?, event_date=?, start_time=?,
          end_time=?, location=?, description=?, color=?, updated_at=datetime('now') WHERE id=?`,
          [ev.summary, eventType, startInfo.date, startInfo.time, endInfo?.time || null,
            ev.location || null, ev.description || null, color, existing.id])
        updated++
      } else {
        db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time,
          end_time, location, description, color, google_event_id) VALUES (?,?,?,?,?,?,?,?,?)`,
          [ev.summary, eventType, startInfo.date, startInfo.time, endInfo?.time || null,
            ev.location || null, ev.description || null, color, uniqueId])
        added++
      }
    }

    if (added + updated > 0) {
      console.log(`[scheduler] Calendar ${label}: ${added} added, ${updated} updated`)
    }
    return { added, updated }
  } catch (err) {
    console.error(`[scheduler] Calendar ${label} sync error:`, err.message)
    return { added: 0, updated: 0, error: err.message }
  }
}

async function syncGoogleCalendar() {
  const urls = (process.env.GOOGLE_CALENDAR_ICAL_URL || '').split(',').map(s => s.trim()).filter(Boolean)
  if (urls.length === 0) return
  for (let i = 0; i < urls.length; i++) {
    const label = `cal${i + 1}`
    await syncOneCalendar(urls[i], label)
  }
}

// Export the incremental sync function so a manual endpoint can trigger it on demand
async function runIncrementalNow() {
  return await syncSierraIncremental()
}

export { syncGoogleCalendar, runIncrementalNow }

export function startScheduler() {
  console.log('[scheduler] Starting auto-sync schedule...')

  setTimeout(() => {
    console.log('[scheduler] Initial boot sync...')
    syncSierraIncremental()
    syncGoogleCalendar()
    // Google Sheet auto-sync DISABLED - hub is source of truth for transactions
  }, 30000)

  // Sierra incremental - backup polling in case webhooks miss anything
  setInterval(syncSierraIncremental, 10 * 60 * 1000)

  // Google Calendar - every 5 min
  setInterval(syncGoogleCalendar, 5 * 60 * 1000)
}
