// People the AI must never contact, registered BY EMAIL AND PHONE rather than by lead id.
//
// John, 2026-10-14: a lead was about to be added in Sierra for listing alerts (Kurt and Lori
// Johnson) with "make sure that AI doesn't reach out to them please" — said BEFORE the lead
// existed anywhere in the Hub.
//
// WHY NOT just set auto_enroll_excluded: that flag lives on ai_lead_state and needs a
// client_id, so it cannot be set until the Sierra sync has created the record. Between the
// sync creating the lead and a person remembering to flag it, auto-enrolment runs, the FUB
// lead watcher runs, and the AI can open a conversation. The whole point of the request is to
// close that window, so the exclusion has to exist before the lead does.
//
// This keys on the things known in advance — the email address and the phone number — and is
// asked at the SAME choke point as every other never-rule (forbidden.js, consulted by
// canSendSms on every AI send: scheduled, responsive, forced and bulk).
//
// The lesson this follows is written up in the FSBO/Holly Stock/Megan Walt history: an
// enrolment-time exclusion is a filter on who joins, not a guard. Four separate fixes failed
// because each guarded the door that had just broken. Anything that must never happen is
// asked where messages actually leave.
//
// SCOPE: the AI channel only. These people still get Sierra listing alerts (that is why they
// were added) and are not opted out of anything — marketing opt-outs are John's to set by
// hand, never mine.
import db from './database.js'

const nowIso = () => new Date().toISOString()

export function initAiNeverContact() {
  try {
    db.run(`CREATE TABLE IF NOT EXISTS ai_never_contact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      phone10 TEXT,
      name TEXT,
      reason TEXT,
      added_by TEXT,
      created_at TEXT NOT NULL
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_anc_email ON ai_never_contact(email)')
    db.run('CREATE INDEX IF NOT EXISTS idx_anc_phone ON ai_never_contact(phone10)')
  } catch {}
}

/** Lowercased and trimmed, or '' when there is nothing usable. */
export function normaliseEmail(e) {
  const s = String(e == null ? '' : e).trim().toLowerCase()
  // A placeholder address must never match another placeholder and block a stranger.
  if (!s || !s.includes('@') || s.includes('notvalidemail')) return ''
  return s
}

/** Last 10 digits, so (319) 431-5859 and +13194315859 are the same number. */
export function normalisePhone(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : ''
}

/**
 * Register someone the AI must never contact. Either an email or a phone is enough; both is
 * better, because a lead can arrive with only one of them.
 */
export function addAiNeverContact({ email = '', phone = '', name = '', reason = '', by = 'agent' } = {}) {
  initAiNeverContact()
  const e = normaliseEmail(email)
  const p = normalisePhone(phone)
  if (!e && !p) return { ok: false, reason: 'need a usable email or phone' }
  const dupe = db.get(
    `SELECT id FROM ai_never_contact WHERE (? != '' AND email = ?) OR (? != '' AND phone10 = ?)`,
    [e, e, p, p])
  if (dupe) return { ok: true, id: dupe.id, already: true }
  db.run(`INSERT INTO ai_never_contact (email, phone10, name, reason, added_by, created_at)
          VALUES (?,?,?,?,?,?)`,
    [e || null, p || null, String(name || '').trim() || null, String(reason || '').trim() || null, by, nowIso()])
  const row = db.get('SELECT id FROM ai_never_contact ORDER BY id DESC LIMIT 1')
  return { ok: true, id: row?.id, already: false }
}

export function removeAiNeverContact(id) {
  initAiNeverContact()
  const r = db.get('SELECT id, email, phone10, name FROM ai_never_contact WHERE id=?', [Number(id)])
  if (!r) return { ok: false, reason: 'not on the list' }
  db.run('DELETE FROM ai_never_contact WHERE id=?', [Number(id)])
  return { ok: true, removed: r }
}

export function listAiNeverContact() {
  initAiNeverContact()
  try {
    // Show whether the lead has actually arrived yet, so the list doubles as a watch list.
    return db.all(`SELECT n.*,
                     (SELECT group_concat(c.id) FROM clients c
                       WHERE c.merged_into IS NULL
                         AND ((n.email IS NOT NULL AND lower(c.email) = n.email)
                           OR (n.phone10 IS NOT NULL AND replace(replace(replace(replace(replace(
                                 c.phone,'(',''),')',''),'-',''),' ',''),'+','') LIKE '%' || n.phone10))
                     ) AS matched_client_ids
                   FROM ai_never_contact n ORDER BY n.id DESC`)
  } catch { return [] }
}

/**
 * Turn an email/phone registration into the ordinary per-lead exclusion once the lead has
 * actually arrived. Runs on the same 10-minute tick as the fresh-enrolment sweep.
 *
 * WHY, given the list already blocks them: the list is keyed on the EMAIL, so if anyone
 * later corrects or changes that address the match quietly stops applying and the AI is free
 * again. Stamping auto_enroll_excluded pins the exclusion to the LEAD, where an email change
 * cannot shake it off. It also makes the exclusion visible on the profile, which is what
 * stops somebody switching AI on without realising — an invisible guard invites that.
 *
 * Both layers stay: the email list covers the window before the lead exists, the stamped
 * flag covers them permanently afterwards. Idempotent — it only ever writes once per lead.
 */
export function backfillAiNeverContact() {
  initAiNeverContact()
  let stamped = 0
  try {
    const entries = db.all('SELECT id, email, phone10, reason FROM ai_never_contact')
    for (const n of entries) {
      const rows = db.all(
        `SELECT c.id FROM clients c
          WHERE c.merged_into IS NULL
            AND ((? != '' AND lower(c.email) = ?) OR (? != '' AND replace(replace(replace(replace(replace(
                  COALESCE(c.phone,''),'(',''),')',''),'-',''),' ',''),'+','') LIKE '%' || ?))
            AND NOT EXISTS (SELECT 1 FROM ai_lead_state s
                             WHERE s.client_id = c.id AND s.auto_enroll_excluded = 1)`,
        [n.email || '', n.email || '', n.phone10 || '', n.phone10 || ''])
      for (const r of rows) {
        try {
          db.run(`INSERT INTO ai_lead_state (client_id) VALUES (?)
                  ON CONFLICT(client_id) DO NOTHING`, [r.id])
        } catch {}
        db.run(`UPDATE ai_lead_state SET auto_enroll_excluded=1, auto_enroll_excluded_by=?,
                auto_enroll_excluded_at=?, auto_enroll_excluded_reason=? WHERE client_id=?`,
          ['ai_never_contact', nowIso(), n.reason || 'AI never-contact list', r.id])
        stamped++
      }
    }
  } catch {}
  return { stamped }
}

/**
 * Is this lead on the never-contact list? Matched on email or phone, NOT on id, so it works
 * for a record that was created seconds ago by a sync and for one that does not exist yet.
 */
export function aiNeverContactMatch(client) {
  if (!client) return null
  const e = normaliseEmail(client.email)
  const p = normalisePhone(client.phone)
  if (!e && !p) return null
  try {
    return db.get(
      `SELECT id, email, phone10, name, reason FROM ai_never_contact
        WHERE (? != '' AND email = ?) OR (? != '' AND phone10 = ?) LIMIT 1`,
      [e, e, p, p]) || null
  } catch { return null }   // table not created yet — nothing registered, nothing to block
}
