// Background scheduler - auto-syncs data without user clicks
import db from './database.js'
import { processLead, sierraGet } from './sierra-helper.js'
import { sendDigest, chicagoDateKey } from './transaction-digest.js'
import { runDailyBackup } from './backup.js'

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

// Sierra's leadCreationDateFrom filter rejects ISO and requires MM/dd/yyyy
// (verified by the 400 response: "Invalid parameter - leadCreationDateFrom.
// Please specify date in MM/dd/yyyy format."). Same UTC instant, different
// format. We use UTC parts so the date is consistent regardless of server tz.
function toSierraDateMMDDYYYY(input) {
  if (!input) return null
  let d
  if (input instanceof Date) d = input
  else if (typeof input === 'string') {
    d = input.includes('T') ? new Date(input) : new Date(input + ' UTC')
  } else {
    d = new Date(input)
  }
  if (isNaN(d.getTime())) return null
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${mm}/${dd}/${yyyy}`
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
    // Subtract a 2-min overlap window. Without this, any lead whose updateDate
    // lands in the same second as our last synced_at can be missed (Sierra's
    // boundary handling on leadUpdateDateFrom is inclusive-or-exclusive
    // depending on the second). Re-processing the same lead is a no-op UPDATE.
    if (sinceDate) {
      const overlapped = new Date(new Date(sinceDate).getTime() - 2 * 60 * 1000)
      sinceDate = toSierraDate(overlapped)
    }
    const sinceFormatted = sinceDate

    let added = 0, updated = 0, total = 0

    // Two passes: by updateDate (catches edits) AND by creationDate (catches
    // imports/new leads where Sierra preserved the source data's old updateDate).
    // processLead is idempotent — a lead seen in both passes just UPDATEs once.
    // NOTE: Sierra uses DIFFERENT date formats per filter — ISO 8601 for
    // leadUpdateDateFrom, MM/dd/yyyy for leadCreationDateFrom. Pass-2 was
    // returning 400 errors every 10 min for ~24h+ until this was fixed.
    const sinceFormattedDateOnly = toSierraDateMMDDYYYY(sinceDate)
    const passes = [
      { name: 'updated', filter: 'leadUpdateDateFrom',   value: sinceFormatted },
      { name: 'created', filter: 'leadCreationDateFrom', value: sinceFormattedDateOnly },
    ]

    // ---- BULK MODE (added 2026-07-07) ----
    // Each processLead() does one upsert = one db.run(). Without bulk mode
    // every single lead triggers a full ~40 MB saveDb(), so a sync touching
    // 100 leads froze the event loop for 14-23s (the "saveDb storm"). Bulk
    // mode defers the disk write so ALL upserts in this sync flush as ONE
    // atomic save via endBulk(). Safe now that saveDb() is atomic (temp file
    // + rename) — the exact pairing that was missing on 2026-05-20.
    // The try/finally guarantees we ALWAYS exit bulk mode; leaving it on
    // would silently stop the whole app from persisting any writes.
    db.beginBulk?.()
    try {
      for (const pass of passes) {
        let page = 1
        let hasMore = true
        while (hasMore) {
          const result = await sierraGet('/leads/find', {
            [pass.filter]: pass.value,
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
      }
    } finally {
      db.endBulk?.()  // single atomic save of every lead upserted this sync
    }

    // Advance the "since" pointer. Runs as its own normal atomic save so the
    // pointer is always persisted independently of the bulk lead batch.
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

// =============================================================
// Daily TC digest scheduling — fires at 9 AM and 1 PM America/Chicago.
// Idempotent via digest_log unique(digest_date, period). Cheap minute-tick
// so DST changes are picked up automatically (no need to recompute UTC).
// =============================================================

const DIGEST_TIMES = [
  { period: 'morning',   hour: 9,  minute: 0 },
  { period: 'afternoon', hour: 13, minute: 0 },
]

function chicagoNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const get = (t) => Number(parts.find(p => p.type === t).value)
  return {
    date: `${get('year')}-${String(get('month')).padStart(2,'0')}-${String(get('day')).padStart(2,'0')}`,
    hour: get('hour') === 24 ? 0 : get('hour'),  // some locales emit '24:00'
    minute: get('minute'),
  }
}

// Daily 10 AM CT Slack deadline alert — posts every buy/list transaction whose
// deadlines are due today or in exactly 3 days to #transaction-tasks-deadlines.
// Idempotent via digest_log period='slack_deadline' (reuses the same table +
// UNIQUE(digest_date, period) guard as the email digest).
const SLACK_DEADLINE_HOUR = 10
async function checkSlackDeadlineTick() {
  try {
    const now = chicagoNow()
    const minutesPast = (now.hour - SLACK_DEADLINE_HOUR) * 60 + now.minute
    if (minutesPast < 0 || minutesPast > 5) return
    const already = db.get(
      "SELECT id FROM digest_log WHERE digest_date = ? AND period = 'slack_deadline' AND success = 1",
      [now.date])
    if (already) return
    console.log(`[slack] firing deadline alert for ${now.date}`)
    const { runDeadlineAlert } = await import('./slack.js')
    const r = await runDeadlineAlert()
    console.log('[slack] deadline alert:', JSON.stringify(r))
    // success=1 means "done for today, don't retry": true when we posted OR when
    // there was simply nothing due. A real post failure (items existed but the
    // webhook errored) logs success=0 so the next minute-tick retries.
    const loggedSuccess = r.posted ? 1 : (r.itemCount === 0 ? 1 : 0)
    try {
      db.run(
        `INSERT INTO digest_log (digest_date, period, recipients, transaction_count, action_count, success, error)
         VALUES (?, 'slack_deadline', '#transaction-tasks-deadlines', ?, ?, ?, ?)`,
        [now.date, r.txCount || 0, r.itemCount || 0, loggedSuccess, r.posted ? null : (r.reason || 'post failed')])
    } catch { /* UNIQUE clash = already logged this date, fine */ }
  } catch (err) {
    console.error('[slack] deadline tick error:', err.message)
  }
}

// Final-walkthrough reminder — fires at 5 PM CT on any deal's walkthrough day.
// Idempotent via digest_log period='slack_walkthrough'.
const WALKTHROUGH_HOUR = 17
async function checkWalkthroughReminderTick() {
  try {
    const now = chicagoNow()
    const minutesPast = (now.hour - WALKTHROUGH_HOUR) * 60 + now.minute
    if (minutesPast < 0 || minutesPast > 5) return
    const already = db.get(
      "SELECT id FROM digest_log WHERE digest_date = ? AND period = 'slack_walkthrough' AND success = 1",
      [now.date])
    if (already) return
    const { runFinalWalkthroughReminder } = await import('./slack.js')
    const r = await runFinalWalkthroughReminder()
    console.log('[slack] walkthrough reminder:', JSON.stringify(r))
    const loggedSuccess = r.posted ? 1 : (r.count === 0 ? 1 : 0)
    try {
      db.run(
        `INSERT INTO digest_log (digest_date, period, recipients, transaction_count, success)
         VALUES (?, 'slack_walkthrough', '#transaction-tasks-deadlines', ?, ?)`,
        [now.date, r.count || 0, loggedSuccess])
    } catch { /* UNIQUE clash = already logged, fine */ }
  } catch (err) {
    console.error('[slack] walkthrough tick error:', err.message)
  }
}

async function checkDigestTick() {
  try {
    const now = chicagoNow()
    for (const slot of DIGEST_TIMES) {
      // Fire when at-or-just-past the scheduled minute (within 5 min, in case the
      // server tick was busy). digest_log uniqueness prevents double-send.
      const minutesPast = (now.hour - slot.hour) * 60 + (now.minute - slot.minute)
      if (minutesPast < 0 || minutesPast > 5) continue
      const already = db.get(
        'SELECT id FROM digest_log WHERE digest_date = ? AND period = ? AND success = 1',
        [now.date, slot.period])
      if (already) continue
      console.log(`[digest] firing ${slot.period} digest for ${now.date} (${now.hour}:${String(now.minute).padStart(2,'0')} CT)`)
      const r = await sendDigest(slot.period)
      console.log('[digest] result:', r.skipped ? `skipped (${r.reason})` : (r.success ? `sent ${r.transactionCount} tx, ${r.actionCount} actions` : `FAILED: ${r.error}`))

      // Morning slot also triggers per-person daily task reminders.
      // Separate idempotency table (daily_reminder_log) so they can fire
      // independently if the digest succeeded but reminders failed (or vice versa).
      if (slot.period === 'morning') {
        try {
          const { sendDailyReminders } = await import('./daily-reminders.js')
          const rr = await sendDailyReminders()
          console.log('[reminders] result:', JSON.stringify(rr.results))
        } catch (rErr) {
          console.error('[reminders] failed:', rErr.message)
        }
      }
    }
  } catch (err) {
    console.error('[digest] tick error:', err.message)
  }
}

async function runDigestNow(period = 'morning', force = true) {
  return await sendDigest(period, { force })
}

async function runDailyRemindersNow(force = true) {
  const { sendDailyReminders } = await import('./daily-reminders.js')
  return await sendDailyReminders({ force })
}

// =============================================================
// Daily backup — fires once a day at 2:00 AM America/Chicago.
// Same minute-tick + done-flag pattern as the digest, idempotent.
// =============================================================
const BACKUP_HOUR = 2
const BACKUP_MINUTE = 0
let lastBackupDate = null

async function checkBackupTick() {
  try {
    const now = chicagoNow()
    const minutesPast = (now.hour - BACKUP_HOUR) * 60 + (now.minute - BACKUP_MINUTE)
    if (minutesPast < 0 || minutesPast > 10) return
    if (lastBackupDate === now.date) return  // already ran today
    lastBackupDate = now.date
    console.log(`[backup] firing daily backup for ${now.date}`)
    await runDailyBackup()
  } catch (err) {
    console.error('[backup] tick error:', err.message)
  }
}

export { syncGoogleCalendar, runIncrementalNow, runDigestNow, runDailyRemindersNow }

// ---------------------------------------------------------------------------
// FUB web-activity incremental sync — keeps each client's "Last Visit" fresh.
// We poll FUB's global /events feed newest-first, stop at the last event id we
// already processed (cursor in app_settings), and for any web event whose
// personId maps to a linked client we advance that client's last_fub_activity.
// Only the LAST-VISIT SUMMARY is stored (never the full 300k-event history), so
// this is memory-safe on the 512MB instance. Full timelines are lazy-loaded
// live via GET /api/fub/activity/live when a client is opened.
// ---------------------------------------------------------------------------
const isFubWebEvent = (e) => !!(e.pageUrl || e.property || e.propertySearch) || /website|visit|view|propert|search|registration|inquir/i.test(e.type || '')

async function syncFubActivityIncremental() {
  try {
    const { fubGet, fubConfigured } = await import('./fub-helper.js')
    const { getSetting, setSetting } = await import('./database.js')
    if (!fubConfigured()) return
    const cursor = Number(getSetting('fub_last_event_id', 0)) || 0

    // Page newest-first until we cross the cursor (or hit a safety page cap).
    let next = '/events?limit=100&sort=-created'
    let maxSeen = cursor, processed = 0, updated = 0, stored = 0, pages = 0
    const seenClient = new Set()
    const prunePending = new Set()
    db.beginBulk?.()
    try {
      while (next && pages < 60) {
        pages++
        const path = next.startsWith('http') ? next.replace('https://api.followupboss.com/v1', '') : next
        const data = await fubGet(path)
        const events = data?.events || []
        if (!events.length) break
        let crossed = false
        for (const e of events) {
          const eid = Number(e.id) || 0
          if (eid > maxSeen) maxSeen = eid
          if (cursor && eid <= cursor) { crossed = true; break }  // reached already-processed territory
          if (!isFubWebEvent(e)) continue
          const pid = e.personId || e.person?.id
          if (!pid) continue
          const client = db.get('SELECT id, last_fub_activity_at FROM clients WHERE fub_person_id = ?', [pid])
          if (!client) continue
          processed++
          const occurred = e.occurred || e.created

          // Cache property-view events in the Hub so Homes They Viewed / the detail
          // panel read them locally instead of hitting FUB live. Dedup by event id.
          const prop = e.property
          if (prop && prop.mlsNumber) {
            const exists = db.get('SELECT id FROM fub_activity WHERE fub_event_id = ?', [e.id])
            if (!exists) {
              db.run(`INSERT INTO fub_activity (fub_event_id, client_id, fub_person_id, type, page_title, page_url, prop_street, prop_city, prop_state, prop_zip, prop_mls, prop_price, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [e.id, client.id, pid, e.type || null, e.pageTitle || null, e.pageUrl || null, prop.street || null, prop.city || null, prop.state || null, prop.code || null, prop.mlsNumber || null, (prop.price != null ? String(prop.price) : null), occurred])
              prunePending.add(client.id)
              stored++
            }
          }

          // newest-first: first time we touch a client this run is their latest visit
          if (seenClient.has(client.id)) continue
          seenClient.add(client.id)
          if (client.last_fub_activity_at && String(client.last_fub_activity_at) >= String(occurred)) continue
          const detail = prop?.street ? (prop.street + (prop.city ? `, ${prop.city}` : '')) : (e.pageTitle || null)
          db.run('UPDATE clients SET last_fub_activity_at = ?, last_fub_activity_type = ?, last_fub_activity_detail = ? WHERE id = ?',
            [occurred, e.type || null, detail, client.id])
          updated++
        }
        if (crossed) break
        next = data?._metadata?.nextLink || data?._metadata?.next || null
      }

      // Keep fub_activity lean: retain only the newest 40 rows per client we touched.
      for (const cid of prunePending) {
        db.run('DELETE FROM fub_activity WHERE client_id = ? AND id NOT IN (SELECT id FROM fub_activity WHERE client_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 40)', [cid, cid])
      }
    } finally { db.endBulk?.() }

    // First run (no cursor): just set the baseline, backfill handles history.
    if (maxSeen > cursor) setSetting('fub_last_event_id', String(maxSeen))
    if (updated || stored) console.log(`[scheduler] FUB activity: ${updated} last-visit updated, ${stored} property views cached (scanned ${pages} pages)`)
  } catch (e) {
    console.error('[scheduler] FUB activity sync error:', e.message)
  }
}

// ---------------------------------------------------------------------------
// FUB "Realist Sell Score" sync — pulls the customRealistSellScore custom field
// (0-1000) for all FUB people and backfills it into the Hub's Realist Score
// (clients.lead_score + A-F grade). Runs weekly; the score only refreshes on
// Realist's cadence. BACKFILL ONLY (lead_score IS NULL/'') so Sierra-sourced
// scores stay authoritative and Sierra's hourly sync doesn't thrash against it.
// Bulk-mode is safe: endBulk() does a single ATOMIC saveDb() at the end.
// ---------------------------------------------------------------------------
function realistGrade(s) {
  if (s >= 800) return 'A+'
  if (s >= 700) return 'A'
  if (s >= 650) return 'B'
  if (s >= 600) return 'C'
  if (s >= 500) return 'D'
  return 'F'
}
async function syncFubRealistScores() {
  try {
    const { fubGet, fubConfigured } = await import('./fub-helper.js')
    if (!fubConfigured()) return
    // Cadence guard: heavy ~600-page FUB /people scan. Skip if it ran in the last
    // 6 days so frequent reboots don't hammer FUB's rate limit.
    const lastRun = Number(db.getSetting?.('fub_realist_last_run', 0)) || 0
    if (lastRun && Date.now() - lastRun < 6 * 24 * 60 * 60 * 1000) { console.log('[scheduler] FUB realist-score sync skipped (ran recently)'); return }
    // Match by EMAIL, not fub_person_id — FUB has duplicate person records and the
    // Realist score often sits on a different duplicate than the one a client is
    // linked to. Email is the dup-proof join. Build email -> client_id for the
    // clients that still need a score (empty, non-junk).
    const lc = (s) => String(s || '').trim().toLowerCase()
    const emailToClient = new Map()
    for (const c of db.all("SELECT id, email FROM clients WHERE (lead_score IS NULL OR lead_score = '') AND email IS NOT NULL AND email != '' AND (status IS NULL OR status NOT IN ('junk','donotcontact','blocked'))")) {
      const e = lc(c.email); if (e && !emailToClient.has(e)) emailToClient.set(e, c.id)
    }
    if (!emailToClient.size) { console.log('[scheduler] FUB realist-score sync: no empty-score clients'); return }

    let next = '/people?limit=100&sort=created&fields=id,emails,customRealistSellScore', pages = 0
    const toSet = new Map()  // client_id -> score
    while (next && pages < 1200) {
      pages++
      const path = next.startsWith('http') ? next.replace('https://api.followupboss.com/v1', '') : next
      const data = await fubGet(path)
      const arr = data?.people || []
      if (!arr.length) break
      for (const p of arr) {
        const s = p.customRealistSellScore
        if (s === undefined || s === null || s === '') continue
        const score = Math.round(Number(s)); if (Number.isNaN(score)) continue
        for (const em of (p.emails || [])) {
          const cid = emailToClient.get(lc(em.value || em.email))
          if (cid && (!toSet.has(cid) || toSet.get(cid) < score)) toSet.set(cid, score)
        }
      }
      next = data?._metadata?.nextLink || data?._metadata?.next || null
      await new Promise(r => setTimeout(r, 80))
    }
    let updated = 0
    db.beginBulk?.()
    try {
      for (const [cid, score] of toSet) {
        const info = db.run(
          "UPDATE clients SET lead_score = ?, lead_grade = ? WHERE id = ? AND (lead_score IS NULL OR lead_score = '')",
          [String(score), realistGrade(score), cid])
        updated += info?.changes || 0
      }
    } finally { db.endBulk?.() }
    db.setSetting?.('fub_realist_last_run', String(Date.now()))
    console.log(`[scheduler] FUB realist-score sync: ${emailToClient.size} empty clients, ${updated} backfilled by email`)
  } catch (e) {
    console.error('[scheduler] FUB realist-score sync error:', e.message)
  }
}

// ---------------------------------------------------------------------------
// FUB budget range — derives each lead's price range from the LIST PRICES of the
// properties they've actually viewed (more accurate than Sierra's preset budget).
// Uses a trimmed range (10th-90th percentile) so one stray browse doesn't skew it.
// Overwrites clients.budget_min/max for linked clients with viewed-property data.
// Runs weekly via a global events scan (memory-safe: only prices per linked person).
// ---------------------------------------------------------------------------
function trimmedRange(prices) {
  const p = prices.filter(v => v > 10000 && v < 10000000).sort((a, b) => a - b)
  if (!p.length) return null
  const round5 = (v) => Math.round(v / 5000) * 5000
  if (p.length < 5) return { lo: round5(p[0]), hi: round5(p[p.length - 1]) }
  const q = (t) => p[Math.min(p.length - 1, Math.max(0, Math.round(t * (p.length - 1))))]
  let lo = round5(q(0.10)), hi = round5(q(0.90))
  if (hi <= lo) hi = round5(p[p.length - 1])
  return { lo, hi: hi <= lo ? lo + 5000 : hi }
}

async function syncFubBudgetRanges() {
  try {
    const { fubGet, fubConfigured } = await import('./fub-helper.js')
    if (!fubConfigured()) return
    // Cadence guard: this is a heavy ~2,600-page FUB scan. Skip if it ran in the
    // last 6 days so frequent reboots don't hammer FUB's rate limit.
    const last = Number(db.getSetting?.('fub_budget_last_run', 0)) || 0
    if (last && Date.now() - last < 6 * 24 * 60 * 60 * 1000) { console.log('[scheduler] FUB budget-range sync skipped (ran recently)'); return }
    // Map linked person -> client (indexed; in-memory to avoid per-event queries).
    const personToClient = new Map()
    for (const c of db.all('SELECT id, fub_person_id FROM clients WHERE fub_person_id IS NOT NULL')) personToClient.set(c.fub_person_id, c.id)
    if (!personToClient.size) return

    const perPerson = new Map()      // personId -> [prices] (cap 300)
    const perPersonCity = new Map()  // personId -> { city: count }
    let next = '/events?limit=100&sort=-created', pages = 0
    while (next && pages < 2600) {
      pages++
      const path = next.startsWith('http') ? next.replace('https://api.followupboss.com/v1', '') : next
      const data = await fubGet(path)
      const events = data?.events || []
      if (!events.length) break
      for (const e of events) {
        const prop = e.property
        if (!prop) continue
        const pid = e.personId || e.person?.id
        if (!pid || !personToClient.has(pid)) continue
        if (prop.price != null) {
          const arr = perPerson.get(pid) || []
          if (arr.length < 300) { arr.push(Number(prop.price)); perPerson.set(pid, arr) }
        }
        const city = (prop.city || '').trim()
        if (city) { const m = perPersonCity.get(pid) || {}; m[city] = (m[city] || 0) + 1; perPersonCity.set(pid, m) }
      }
      next = data?._metadata?.nextLink || data?._metadata?.next || null
      await new Promise(r => setTimeout(r, 70))
    }
    // Freq-ordered, normalized + de-duped city list per person (cap 12).
    // FUB city values sometimes carry trailing commas / casing variants, so fold them.
    const cityList = (m) => {
      const norm = {}
      for (const [raw, ct] of Object.entries(m)) {
        const c = String(raw).replace(/^[,\s]+|[,\s]+$/g, '').trim()
        if (!c) continue
        const key = c.toLowerCase()
        if (!norm[key]) norm[key] = { name: c, count: 0 }
        norm[key].count += ct
      }
      return Object.values(norm).sort((a, b) => b.count - a.count).slice(0, 12).map(x => x.name).join(', ')
    }
    let updated = 0, citiesSet = 0
    db.beginBulk?.()
    try {
      for (const [pid, prices] of perPerson) {
        const range = trimmedRange(prices)
        if (!range) continue
        const info = db.run('UPDATE clients SET budget_min = ?, budget_max = ? WHERE fub_person_id = ?', [range.lo, range.hi, pid])
        updated += info?.changes || 0
      }
      for (const [pid, cities] of perPersonCity) {
        const list = cityList(cities)
        if (!list) continue
        const info = db.run('UPDATE clients SET fub_viewed_cities = ? WHERE fub_person_id = ?', [list, pid])
        citiesSet += info?.changes || 0
      }
    } finally { db.endBulk?.() }
    db.setSetting?.('fub_budget_last_run', String(Date.now()))
    console.log(`[scheduler] FUB budget-range sync: ${perPerson.size} leads priced (${updated} budgets), ${perPersonCity.size} with cities (${citiesSet} set)`)
  } catch (e) {
    console.error('[scheduler] FUB budget-range sync error:', e.message)
  }
}

export function startScheduler() {
  console.log('[scheduler] Starting auto-sync schedule...')

  // Seed the heavy-scan cadence stamps on first boot (data was already backfilled),
  // so the ~2,600-page budget scan + ~600-page realist scan don't re-run on every
  // reboot and burn FUB's rate limit. They'll next run ~6 days out.
  try {
    if (!Number(db.getSetting?.('fub_budget_last_run', 0))) db.setSetting?.('fub_budget_last_run', String(Date.now()))
    if (!Number(db.getSetting?.('fub_realist_last_run', 0))) db.setSetting?.('fub_realist_last_run', String(Date.now()))
  } catch {}

  setTimeout(() => {
    console.log('[scheduler] Initial boot sync...')
    syncSierraIncremental()
    syncGoogleCalendar()
    // Google Sheet auto-sync DISABLED - hub is source of truth for transactions
  }, 30000)

  // Sierra incremental - backup polling in case webhooks miss anything.
  // Was 10 min, bumped to 60 min on 2026-05-21 because each sync freezes
  // the event loop for 14-23s during the per-lead saveDb() storm. Hourly
  // cadence drops the user-facing slowness probability ~6x. Sierra's own
  // email/SMS notifications and webhook (if configured) still arrive
  // instantly for new leads — this loop only catches what webhooks miss.
  // Real cure is still the atomic-save + bulk-mode refactor (Bug B).
  setInterval(syncSierraIncremental, 60 * 60 * 1000)

  // Google Calendar - every 5 min
  setInterval(syncGoogleCalendar, 5 * 60 * 1000)

  // TC daily digest - check every minute, fires at 9 AM + 1 PM CT (idempotent)
  setInterval(checkDigestTick, 60 * 1000)

  // Slack deadline alert - check every minute, fires at 10 AM CT (idempotent)
  setInterval(checkSlackDeadlineTick, 60 * 1000)
  setTimeout(checkSlackDeadlineTick, 50 * 1000)  // also shortly after boot in case we deployed past 10 AM

  // Final-walkthrough reminder - every minute, fires at 5 PM CT on walkthrough day
  setInterval(checkWalkthroughReminderTick, 60 * 1000)

  // Timed task reminders - every minute, fires Slack 30 min + 5 min before a
  // task's due date+time (idempotent via reminder_30_sent / reminder_5_sent).
  setInterval(async () => {
    try {
      const { checkTaskReminders } = await import('./task-reminders.js')
      await checkTaskReminders()
    } catch (e) { console.error('[scheduler] task-reminders error:', e.message) }
  }, 60 * 1000)

  // Transaction deadline tasks - hourly (+ shortly after boot). Surfaces each
  // deadline as a task only once it's within 3 days, so the list stays uncluttered.
  const runDeadlineTaskSync = async () => {
    try {
      const { syncAllActiveTransactionDeadlineTasks } = await import('./routes/transactions.js')
      const n = syncAllActiveTransactionDeadlineTasks()
      console.log(`[scheduler] deadline-task sync ran over ${n} active transactions`)
    } catch (e) { console.error('[scheduler] deadline-task sync error:', e.message) }
  }
  setInterval(runDeadlineTaskSync, 60 * 60 * 1000)
  setTimeout(runDeadlineTaskSync, 55 * 1000)
  // Also run once shortly after boot in case we just deployed past the scheduled time
  setTimeout(checkDigestTick, 45 * 1000)

  // Daily backup tick (2:00 AM CT) — disk rotation + gzipped email attachment
  setInterval(checkBackupTick, 60 * 1000)

  // FUB web-activity incremental sync — hourly (+ shortly after boot). Keeps the
  // "Last Visit" column fresh for all linked clients without storing full history.
  setInterval(syncFubActivityIncremental, 60 * 60 * 1000)
  setTimeout(syncFubActivityIncremental, 90 * 1000)

  // FUB Realist Score backfill sync — weekly (+ once ~2 min after boot).
  setInterval(syncFubRealistScores, 7 * 24 * 60 * 60 * 1000)
  setTimeout(syncFubRealistScores, 120 * 1000)

  // FUB budget-range sync (price range from viewed properties) — weekly.
  setInterval(syncFubBudgetRanges, 7 * 24 * 60 * 60 * 1000)
  setTimeout(syncFubBudgetRanges, 200 * 1000)
}
