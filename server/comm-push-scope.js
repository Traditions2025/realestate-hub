// How much is left to push, and how long it would actually take.
//
// John, 2026-10-14: "if we push everything from HUB to Sierra and FUB how long does that
// take — I'm talking emails and text and notes."
//
// Both destinations are rate-limited, so the answer is arithmetic, not a guess: eligible
// rows x the pace each API tolerates. The eligibility rules here are the SAME ones
// fub-comm-push.js uses to select a batch, so the count is what would really be sent and
// not an optimistic total of the communications table.
//
// Read-only. It counts and divides; it sends nothing.
import db from './database.js'

// Pace per destination, in ms between calls.
//  FUB   — 260ms, the figure the live push already runs at.
//  Sierra— 800ms, from the 429s hit during bulk tag writes, plus a ~6s backoff when one
//          lands. Sierra is the slower of the two by a factor of three.
export const FUB_PACE_MS = 260
export const SIERRA_PACE_MS = 800

const CHANNELS = ['text', 'call', 'voicemail', 'email']

// A row the Hub itself originated. A `fub_` id is something we imported FROM FUB, and a
// `gmail_` id is mail we imported from the team's own mailboxes — pushing either sends data
// back toward where it came from, and the Gmail sweep keeps making more, so a job that
// included them would never finish (learned the hard way, 2026-10-08).
const HUB_ORIGIN = "(m.external_id LIKE 'twilio_%' OR m.external_id LIKE 'hub_%')"

// The Hub talking to itself: TC digests, "X emailed you", home-value alerts, all addressed
// to the team's own records. Never worth a note in anyone's CRM.
const NOT_OURSELVES = `lower(COALESCE(c.email,'')) NOT LIKE '%@mattsmithteam.com'
  AND lower(COALESCE(c.email,'')) NOT IN ('mattsmithremax@gmail.com','johnwithmattsmithteam@gmail.com')`

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} sec`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60); const rm = m % 60
  if (h < 36) return rm ? `${h} hr ${rm} min` : `${h} hr`
  return `${(h / 24).toFixed(1)} days`
}

export function commPushScope() {
  const ph = CHANNELS.map(() => '?').join(',')

  // Everything in the table, for context on how much is NOT eligible and why.
  const byOrigin = db.all(`SELECT
      CASE WHEN external_id LIKE 'twilio_%' THEN 'twilio (Hub)'
           WHEN external_id LIKE 'hub_%'    THEN 'hub'
           WHEN external_id LIKE 'fub_%'    THEN 'fub (imported)'
           WHEN external_id LIKE 'gmail_%'  THEN 'gmail (imported)'
           WHEN external_id LIKE 'conv_%'   THEN 'conv (Hub group)'
           ELSE 'other' END AS origin,
      channel, COUNT(*) n
    FROM communications WHERE channel IN (${ph})
    GROUP BY origin, channel ORDER BY n DESC`, CHANNELS)

  const eligible = (linkCol, pushedTable) => {
    const notPushed = pushedTable
      ? ` AND m.id NOT IN (SELECT communication_id FROM ${pushedTable})` : ''
    const base = `FROM communications m JOIN clients c ON c.id = m.client_id
      WHERE m.channel IN (${ph}) AND c.${linkCol} IS NOT NULL AND c.merged_into IS NULL
        AND ${NOT_OURSELVES} AND ${HUB_ORIGIN}${notPushed}`
    const rows = db.all(`SELECT m.channel, COUNT(*) n ${base} GROUP BY m.channel`, CHANNELS)
    const leads = db.get(`SELECT COUNT(DISTINCT c.id) n ${base}`, CHANNELS)?.n || 0
    const total = rows.reduce((a, r) => a + r.n, 0)
    const oldest = db.get(`SELECT MIN(m.occurred_at) d ${base}`, CHANNELS)?.d || null
    return { total, leads, oldest, by_channel: Object.fromEntries(rows.map(r => [r.channel, r.n])) }
  }

  // FUB: a push already ran forward-only from 2026-10-01, so fub_comm_pushed excludes
  // what is already there. Sierra has never been pushed, so nothing is excluded.
  let fub
  try { fub = eligible('fub_person_id', 'fub_comm_pushed') }
  catch { fub = eligible('fub_person_id', null) }
  const sierra = eligible('sierra_lead_id', null)

  const project = (n, paceMs) => ({
    calls: n,
    pace_ms: paceMs,
    seconds: Math.round((n * paceMs) / 1000),
    human: fmtDuration(n * paceMs),
  })

  const fubRun = project(fub.total, FUB_PACE_MS)
  const sierraRun = project(sierra.total, SIERRA_PACE_MS)

  return {
    note: 'Counts use the same eligibility rules the live push uses. Read-only; nothing was sent.',
    by_origin: byOrigin,
    fub: { ...fub, run: fubRun, already_pushed: db.get('SELECT COUNT(*) n FROM fub_comm_pushed')?.n ?? null },
    sierra: { ...sierra, run: sierraRun, already_pushed: 0, needs: 'a sierra_comm_pushed table; nothing has been pushed yet' },
    both_sequential: fmtDuration(fub.total * FUB_PACE_MS + sierra.total * SIERRA_PACE_MS),
    both_parallel: fmtDuration(Math.max(fub.total * FUB_PACE_MS, sierra.total * SIERRA_PACE_MS)),
    caveats: [
      'Sierra has NO endpoint that logs a text, email or call - everything lands as a NOTE.',
      'FUB is the same: /textMessages POST needs a registered system, so the live push writes notes too.',
      'Wall-clock assumes a clean run. A 429 adds ~6s, and Render restarts mid-run, so a job this long must be resumable by after_id rather than one request.',
      'Notes typed on a Hub profile live in clients.notes, not communications, and are NOT counted here.',
    ],
  }
}
