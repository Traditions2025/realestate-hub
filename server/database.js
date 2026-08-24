import Database from 'better-sqlite3'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, readdirSync, copyFileSync, openSync, fsyncSync, closeSync, unlinkSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Use persistent disk path on Render if mounted, otherwise local
const DB_DIR = process.env.DB_DIR || join(__dirname, '..')
const DB_PATH = join(DB_DIR, 'realestate-hub.db')

let db            // sql.js-compatible shim over a live better-sqlite3 connection
let _bulkDepth = 0

// better-sqlite3 is stricter than sql.js about bind params: it rejects undefined
// and booleans. Coerce them (undefined->null, boolean->0/1) so all ~200 existing
// call sites keep working unchanged.
function sanitizeParams(params) {
  const a = params || []
  const out = new Array(a.length)
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    out[i] = p === undefined ? null : (typeof p === 'boolean' ? (p ? 1 : 0) : p)
  }
  return out
}

// Thin object mimicking the sql.js Database surface the rest of this file uses
// (run/get/all/exec/export/prepare/close), backed by better-sqlite3. Lets every
// existing `db.run(...)` schema + migration call work with zero changes.
function makeDbShim(raw) {
  return {
    _raw: raw,
    run(sql, params = []) {
      if (params && params.length) {
        const info = raw.prepare(sql).run(...sanitizeParams(params))
        return { lastInsertRowid: info.lastInsertRowid, changes: info.changes }
      }
      raw.exec(sql)                 // DDL / no-param / multi-statement
      return { lastInsertRowid: undefined, changes: 0 }
    },
    get(sql, params = []) { return raw.prepare(sql).get(...sanitizeParams(params)) || null },
    all(sql, params = []) { return raw.prepare(sql).all(...sanitizeParams(params)) },
    exec(sql) { raw.exec(sql) },
    prepare(sql) { return raw.prepare(sql) },
    export() { return raw.serialize() },
    pragma(p, opts) { return raw.pragma(p, opts) },
    getRowsModified() { return 0 },
    close() { try { raw.close() } catch {} },
  }
}

// Open (or create) the SQLite file with better-sqlite3 and set safe pragmas.
// Rollback-journal (DELETE) mode + synchronous FULL keeps the single .db file
// always-current and durable, so the existing file-copy backups + corruption
// recovery keep working unchanged (no WAL sidecar files). Unlike sql.js, the DB
// is NOT held whole in memory and is NOT re-serialized on every write.
function openDbFile(path) {
  const raw = new Database(path)
  raw.pragma('journal_mode = DELETE')
  raw.pragma('synchronous = FULL')
  raw.pragma('foreign_keys = OFF')
  return makeDbShim(raw)
}

export async function initDb() {
  // Ensure DB directory exists
  console.log(`[db] Database path: ${DB_PATH}`)
  console.log(`[db] DB_DIR env var: ${process.env.DB_DIR || '(not set, using local)'}`)
  if (!existsSync(DB_DIR)) {
    try {
      mkdirSync(DB_DIR, { recursive: true })
      console.log(`[db] Created directory: ${DB_DIR}`)
    } catch (e) {
      console.error(`[db] FAILED to create ${DB_DIR}: ${e.message}`)
    }
  }

  // ---- DISK-MOUNT RACE FIX (added 2026-05-12 after 3rd data wipe) ----
  // Render's persistent disk mounts asynchronously. The Node process can
  // start BEFORE /data is fully visible, in which case existsSync(DB_PATH)
  // returns false even though the real file exists on disk.
  // Without retries: boot's `else` branch ran (created empty in-memory DB),
  // then saveDb() at end of initDb wrote the empty DB on top of the real
  // 24 MB file → silent data loss.
  const backupDir = join(DB_DIR, 'backups')

  // STEP 1: wait up to 30s for /data to mount. Wait for BOTH the main
  // file path AND the backups dir to be visible — earlier version of
  // this code exited as soon as either appeared, which meant the
  // backups-dir check below could miss backups if /data/backups mounted
  // slightly after /data/realestate-hub.db.
  let attempts = 0
  const wantBoth = () => existsSync(DB_PATH) && existsSync(backupDir)
  const wantEither = () => existsSync(DB_PATH) || existsSync(backupDir)
  // First wait for ANY signal that the disk mounted at all
  while (!wantEither() && attempts < 60) {
    console.log(`[db] waiting for /data to mount... (${attempts+1}/60)`)
    await new Promise(r => setTimeout(r, 500))
    attempts++
  }
  // Then wait briefly for the OTHER path so we don't make a decision
  // based on a half-mounted disk
  const settleStart = attempts
  while (!wantBoth() && attempts < settleStart + 20) {
    await new Promise(r => setTimeout(r, 500))
    attempts++
  }
  console.log(`[db] /data probe: DB_PATH exists=${existsSync(DB_PATH)} size=${existsSync(DB_PATH) ? statSync(DB_PATH).size : 'n/a'}, backupDir exists=${existsSync(backupDir)}`)

  // STEP 2: find newest usable backup (used either for auto-restore OR
  // for sanity comparison if the main file is suspiciously small).
  function newestUsableBackup() {
    if (!existsSync(backupDir)) return null
    try {
      const files = readdirSync(backupDir)
        .filter(f => f.startsWith('realestate-hub.db.'))
        .map(f => {
          const p = join(backupDir, f)
          const s = statSync(p)
          return { name: f, path: p, size: s.size, mtime: s.mtimeMs }
        })
        .filter(x => x.size > 100 * 1024)  // > 100 KB = real data
        .sort((a, b) => b.mtime - a.mtime)
      return files[0] || null
    } catch (e) {
      console.error('[db] reading backups dir failed:', e.message)
      return null
    }
  }

  // STEP 3: decide whether to auto-restore. The trigger conditions:
  //   - File is missing entirely, OR
  //   - File is too tiny to contain real data (< 100 KB), OR
  //   - File is suspiciously small compared to the newest backup
  //     (< 50% of backup size — strong signal the disk was wiped)
  // The 50% ratio handles the case we hit at 18:11 — file at 148 KB
  // (just above absolute threshold) but backup at 24 MB. Ratio catches it.
  const dbExists = existsSync(DB_PATH)
  const liveSize = dbExists ? statSync(DB_PATH).size : 0
  const backup = newestUsableBackup()
  const suspicious =
    !dbExists ||
    liveSize < 100 * 1024 ||
    (backup && liveSize < backup.size * 0.5)
  if (suspicious) {
    if (backup) {
      console.warn(`[db] !!! Main DB looks wiped: live=${liveSize} bytes, newest backup=${backup.size} bytes (${backup.name})`)
      console.warn(`[db] !!! Auto-restoring from backup.`)
      try {
        if (dbExists) {
          const aside = `${DB_PATH}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`
          renameSync(DB_PATH, aside)
          console.warn(`[db] !!! suspect file moved to ${aside}`)
        }
        copyFileSync(backup.path, DB_PATH)
        console.warn(`[db] !!! restore complete: ${statSync(DB_PATH).size} bytes`)
      } catch (e) {
        console.error('[db] auto-restore copy failed:', e.message)
      }
    } else if (!dbExists) {
      console.log('[db] no DB and no usable backup — truly first boot')
    }
  }

  if (existsSync(DB_PATH)) {
    const stats = statSync(DB_PATH)
    console.log(`[db] Loading existing database (${(stats.size / 1024).toFixed(1)} KB, modified ${stats.mtime.toISOString()})`)

    // ---- LAYER 2: pre-boot snapshot ----
    try {
      const { backupDbToDisk, rotateBackups } = await import('./backup.js')
      const snap = backupDbToDisk('pre-boot')
      if (snap.path) {
        console.log(`[db] pre-boot snapshot saved: ${snap.filename} (${(snap.size/1024).toFixed(0)} KB)`)
        rotateBackups('pre-boot', 10)
      }
    } catch (e) {
      console.error(`[db] pre-boot snapshot failed: ${e.message}`)
    }

    try {
      db = openDbFile(DB_PATH)
      const qc = db.pragma('quick_check', { simple: true })
      if (qc !== 'ok') throw new Error(`quick_check reported: ${qc}`)
    } catch (corruptErr) {
      try { if (db && db.close) db.close() } catch {}
      db = null
      console.error('[db] ============================================')
      console.error(`[db] !!! DATABASE FILE FAILED TO LOAD: ${corruptErr.message}`)
      console.error(`[db] !!! File: ${DB_PATH}`)
      console.error('[db] !!! Searching for the newest VALID backup to auto-restore...')
      console.error('[db] ============================================')

      // Build candidate list: all backups + all sidecar files in /data/.
      // Validate each by loading with sql.js + PRAGMA quick_check. Use the
      // newest one that loads cleanly. Skip the pre-boot snapshot taken on
      // THIS boot — that's a copy of the corrupt file.
      const candidates = []
      try {
        if (existsSync(backupDir)) {
          for (const f of readdirSync(backupDir)) {
            if (!f.startsWith('realestate-hub.db.')) continue
            try {
              const p = join(backupDir, f)
              const s = statSync(p)
              candidates.push({ path: p, name: `backups/${f}`, mtime: s.mtime, size: s.size })
            } catch {}
          }
        }
        for (const f of readdirSync(DB_DIR)) {
          if (!f.startsWith('realestate-hub.db.')) continue
          if (f === 'realestate-hub.db') continue
          // Skip the pre-boot snapshot we JUST made of the corrupt file
          if (f.startsWith('realestate-hub.db.pre-boot-')) {
            try {
              const p = join(DB_DIR, f)
              const s = statSync(p)
              // Only skip if the snapshot is suspiciously close in size+time to the corrupt live file
              const liveStat = statSync(DB_PATH)
              if (Math.abs(s.size - liveStat.size) < 1024 && Math.abs(s.mtime - liveStat.mtime) < 5 * 60 * 1000) {
                console.error(`[db] (skipping recent pre-boot snapshot ${f} — likely a copy of the corrupt file)`)
                continue
              }
            } catch {}
          }
          try {
            const p = join(DB_DIR, f)
            const s = statSync(p)
            if (!s.isFile()) continue
            candidates.push({ path: p, name: f, mtime: s.mtime, size: s.size })
          } catch {}
        }
      } catch (listErr) {
        console.error(`[db] !!! could not list candidates: ${listErr.message}`)
      }

      // Newest first
      candidates.sort((a, b) => b.mtime - a.mtime)
      console.error(`[db] !!! Found ${candidates.length} candidate file(s) to try`)

      let restoredFrom = null
      for (const c of candidates) {
        try {
          const testDb = new Database(c.path, { readonly: true, fileMustExist: true })
          const cqc = testDb.pragma('quick_check', { simple: true })
          testDb.close()
          if (cqc !== 'ok') throw new Error(`quick_check: ${cqc}`)
          restoredFrom = c
          console.error(`[db] !!! Candidate VALID: ${c.name} (${(c.size/1024).toFixed(0)} KB, ${c.mtime.toISOString()})`)
          break
        } catch (testErr) {
          console.error(`[db] !!! Candidate INVALID: ${c.name} — ${testErr.message}`)
        }
      }

      if (!restoredFrom) {
        console.error('[db] ============================================')
        console.error('[db] !!! NO VALID BACKUP FOUND. Crashing instead of wiping data.')
        console.error('[db] !!! Manual recovery needed — check /data/ for sidecar files.')
        console.error('[db] ============================================')
        throw corruptErr
      }

      // Safety contract: NEVER lose the corrupt bytes. We COPY the corrupt
      // file to a sidecar FIRST (so the bytes are preserved even if the next
      // step fails), and only then overwrite the live file with the backup.
      // If the sidecar copy fails for any reason, ABORT — leave the live file
      // untouched and crash with the original error. This guarantees the user
      // never loses access to the original corrupted bytes for recovery.
      const corruptAside = `${DB_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try {
        copyFileSync(DB_PATH, corruptAside)
        console.error(`[db] !!! Corrupt file copied to ${corruptAside} (original at ${DB_PATH} still intact for now)`)
      } catch (cpErr) {
        console.error('[db] ============================================')
        console.error(`[db] !!! Could NOT preserve corrupt file to sidecar: ${cpErr.message}`)
        console.error('[db] !!! Aborting auto-restore. Live file is UNTOUCHED.')
        console.error('[db] !!! Manual recovery needed — file at ' + DB_PATH + ' still has the (corrupt) original bytes.')
        console.error('[db] ============================================')
        throw corruptErr
      }
      // Sidecar is safe. Now overwrite the live file with the chosen backup.
      copyFileSync(restoredFrom.path, DB_PATH)
      console.error(`[db] !!! Restored from ${restoredFrom.name}`)
      db = openDbFile(DB_PATH)
      const rqc = db.pragma('quick_check', { simple: true })
      if (rqc !== 'ok') throw new Error(`restored DB quick_check: ${rqc}`)
      console.error('[db] !!! Restored DB loaded successfully. Service continuing.')
      console.error('[db] !!! NOTE: any data written between the backup time and the corruption may be in')
      console.error(`[db] !!!       the sidecar at ${corruptAside}. Original corrupt bytes are preserved there.`)
    }
  } else {
    // Truly no DB anywhere — first-ever boot OR Render disk really is empty.
    // This is now a rare path because of the retry+auto-restore above.
    console.log(`[db] No existing database AND no usable backup, creating new at ${DB_PATH}`)
    db = openDbFile(DB_PATH)
  }

  // ---- LAYER 3: migration ledger ----
  // Future migrations should use runMigration(name, fn) so each runs exactly
  // once. The agency_type bug existed because the recreate-table migration
  // re-ran on every boot, retrying a half-broken state each time. With the
  // ledger, that pattern is impossible: name = applied = done forever.
  db.run(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
  )`)

  // =============================================
  // CLIENTS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      type TEXT NOT NULL CHECK(type IN ('buyer', 'seller', 'both')),
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT,
      agent_assigned TEXT,
      address TEXT,
      city TEXT,
      state TEXT DEFAULT 'IA',
      zip TEXT,
      budget_min REAL,
      budget_max REAL,
      preapproval_amount REAL,
      preapproval_lender TEXT,
      sierra_lead_id TEXT,
      lead_score TEXT,
      lead_grade TEXT,
      visits INTEGER DEFAULT 0,
      email_status TEXT,
      phone_status TEXT,
      sierra_update_date TEXT,
      sierra_creation_date TEXT,
      pond_id INTEGER,
      marketing_email_opt_out INTEGER DEFAULT 0,
      text_opt_out INTEGER DEFAULT 0,
      ealert_opt_out INTEGER DEFAULT 0,
      short_summary TEXT,
      tags TEXT,
      lender_name TEXT,
      lender_status TEXT,
      listing_agent_status TEXT,
      search_price_min REAL,
      search_price_max REAL,
      search_beds_min INTEGER,
      search_baths_min INTEGER,
      search_sqft_min INTEGER,
      search_regions TEXT,
      search_property_types TEXT,
      has_saved_search INTEGER DEFAULT 0,
      realist_market_value REAL,
      realist_assessed_value REAL,
      realist_year_built INTEGER,
      realist_bedrooms INTEGER,
      realist_bathrooms_full INTEGER,
      realist_owner_occupied INTEGER,
      realist_sell_score INTEGER,
      realist_last_sale_price REAL,
      realist_last_sale_date TEXT,
      realist_property_id INTEGER,
      realist_matched_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // TRANSACTIONS - Matches Google Sheet exactly
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Core Info (Cols A-I)
      property_address TEXT NOT NULL,
      mls_number TEXT,
      type TEXT NOT NULL DEFAULT 'purchase',
      source TEXT,
      buyer_name TEXT,
      buyers_agent_name TEXT,
      seller_name TEXT,
      sellers_agent_name TEXT,
      agency_type TEXT,
      -- Status & Pricing (Cols J-L)
      property_status TEXT NOT NULL DEFAULT 'Active',
      list_price REAL,
      purchase_price REAL,
      -- Key Dates (Cols M-V)
      contract_date TEXT,
      closing_date TEXT,
      mortgage_contingency_date TEXT,
      appraisal_contingency_date TEXT,
      appraisal_contingency_status TEXT DEFAULT 'Not Started',
      inspection_contingency_date TEXT,
      financing_release TEXT,
      final_walkthrough TEXT,
      inspection_release TEXT,
      final_inspection_waiver TEXT,
      -- Finance
      type_of_finance TEXT,
      earnest_money_due_date TEXT,
      ipi_due_date TEXT,
      lender_name TEXT,
      lender_company TEXT,
      lender_email TEXT,
      dotloop_status TEXT DEFAULT 'Not Submitted',
      has_insurance_contingency INTEGER DEFAULT 1,
      has_home_warranty INTEGER DEFAULT 1,
      -- Checklist Items (boolean columns from sheet)
      remove_listing_alerts INTEGER DEFAULT 0,
      email_contract_closing INTEGER DEFAULT 0,
      ayse_added_to_loop INTEGER DEFAULT 0,
      ayse_contracts_signed INTEGER DEFAULT 0,
      earnest_money_deposit TEXT DEFAULT 'Not Started',
      home_inspection TEXT DEFAULT 'Not Started',
      home_inspector TEXT,
      inspection_date TEXT,
      whole_property_inspection INTEGER DEFAULT 0,
      radon_test INTEGER DEFAULT 0,
      wdi_inspection INTEGER DEFAULT 0,
      septic_inspection INTEGER DEFAULT 0,
      well_inspection INTEGER DEFAULT 0,
      sewer_inspection INTEGER DEFAULT 0,
      seller_acknowledgment INTEGER DEFAULT 0,
      abstract TEXT,
      title_commitment TEXT,
      mortgage_payoff TEXT,
      alta_statement TEXT,
      deed_package TEXT,
      utilities_set INTEGER DEFAULT 0,
      sales_worksheet_added INTEGER DEFAULT 0,
      submit_loop_review INTEGER DEFAULT 0,
      approved_commission INTEGER DEFAULT 0,
      closing_complete INTEGER DEFAULT 0,
      testimonial_request INTEGER DEFAULT 0,
      -- Extra
      client_id INTEGER,
      tc_assigned TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `)

  // =============================================
  // PRE-LISTING (Potential Sellers pipeline)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS pre_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_address TEXT NOT NULL,
      owner_name TEXT,
      walkthrough TEXT DEFAULT 'Not Scheduled',
      status TEXT DEFAULT 'New',
      -- Pre-listing checklist (matches Google Sheet Potential Sellers tab)
      marketing_materials_sent INTEGER DEFAULT 0,
      seller_discovery_form INTEGER DEFAULT 0,
      cma INTEGER DEFAULT 0,
      seller_netsheet INTEGER DEFAULT 0,
      loop_created INTEGER DEFAULT 0,
      listing_contract_signed INTEGER DEFAULT 0,
      getting_home_ready INTEGER DEFAULT 0,
      schedule_photoshoot INTEGER DEFAULT 0,
      get_spare_keys INTEGER DEFAULT 0,
      install_lockbox INTEGER DEFAULT 0,
      install_signs INTEGER DEFAULT 0,
      written_description INTEGER DEFAULT 0,
      coming_soon_post INTEGER DEFAULT 0,
      coming_soon_email INTEGER DEFAULT 0,
      listing_submitted_mls INTEGER DEFAULT 0,
      posted_social_media INTEGER DEFAULT 0,
      notes TEXT,
      client_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `)

  // =============================================
  // TASKS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'todo',
      due_date TEXT,
      assigned_to TEXT,
      category TEXT,
      related_type TEXT,
      related_id INTEGER,
      notes_log TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // PROJECTS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      category TEXT,
      priority TEXT DEFAULT 'medium',
      due_date TEXT,
      owner TEXT,
      progress INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // Visual mind-map canvas (nodes + edges JSON) per project.
  try { db.run('ALTER TABLE projects ADD COLUMN canvas_data TEXT') } catch {}

  // ---- AUTOMATIONS: user-built workflows (trigger + conditions + actions) ----
  db.run(`
    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      trigger_type TEXT DEFAULT 'schedule_daily',
      run_time TEXT DEFAULT '09:00',
      audience TEXT,        -- JSON: client filter (conditions + include/exclude)
      actions TEXT,         -- JSON: ordered [{type, config}]
      last_run_at TEXT,
      last_run_summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // Visual flow: { trigger: {type, config}, steps: [{id, kind, ...}] }
  try { db.run('ALTER TABLE automations ADD COLUMN flow_data TEXT') } catch {}

  // ---- EMAIL CAMPAIGNS: one row per batch send, for the Reporting tab ----
  db.run(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      from_name TEXT,
      category TEXT,          -- SendGrid category tag used to pull stats
      recipients INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      status TEXT DEFAULT 'sending',
      created_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    )
  `)
  try { db.run('ALTER TABLE email_log ADD COLUMN campaign_id INTEGER') } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER,
      run_at TEXT DEFAULT (datetime('now')),
      matched INTEGER DEFAULT 0,
      actions_done INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      detail TEXT
    )
  `)

  // ---- AUTOMATIONS v2: graph model, versioning, per-contact runtime ----
  // status: draft | active | paused | error   (legacy `enabled` still mirrored)
  try { db.run("ALTER TABLE automations ADD COLUMN status TEXT DEFAULT 'draft'") } catch {}
  try { db.run('ALTER TABLE automations ADD COLUMN draft_graph TEXT') } catch {}   // {nodes,edges} being edited
  try { db.run('ALTER TABLE automations ADD COLUMN active_graph TEXT') } catch {}  // {nodes,edges} the runtime executes
  try { db.run('ALTER TABLE automations ADD COLUMN owner TEXT') } catch {}
  try { db.run('ALTER TABLE automations ADD COLUMN settings TEXT') } catch {}      // JSON: enrollment/limits/quiet-hours
  try { db.run('ALTER TABLE automations ADD COLUMN activated_at TEXT') } catch {}
  try { db.run('ALTER TABLE automations ADD COLUMN description TEXT') } catch {}
  try { db.run('ALTER TABLE automations ADD COLUMN active_version INTEGER DEFAULT 0') } catch {}

  // published/draft snapshots for version history + restore
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER,
      version_number INTEGER,
      graph TEXT,
      settings TEXT,
      status TEXT DEFAULT 'published',   -- published | draft
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      published_at TEXT
    )
  `)

  // one row per contact currently/previously in an automation
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER,
      version_number INTEGER,
      client_id INTEGER,
      status TEXT DEFAULT 'active',      -- active | waiting | completed | failed | removed
      current_node_id TEXT,
      next_run_at TEXT,                  -- when the stepper should next touch this row (ISO UTC)
      entered_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      exit_reason TEXT,
      last_error TEXT,
      context TEXT                       -- JSON: trigger payload (e.g. the viewed listing)
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_enroll_due ON automation_enrollments(status, next_run_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_enroll_auto ON automation_enrollments(automation_id, client_id)') } catch {}

  // one row per action attempt — idempotency + activity/troubleshooting
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_id INTEGER,
      automation_id INTEGER,
      node_id TEXT,
      node_type TEXT,
      status TEXT DEFAULT 'success',     -- success | failed | skipped
      attempt INTEGER DEFAULT 1,
      idempotency_key TEXT UNIQUE,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      output TEXT,
      error TEXT
    )
  `)

  // ---- DRIP CAMPAIGNS: reusable multi-email sequences (email -> wait -> email) ----
  // steps JSON: [{id, delay_days, send_time 'HH:MM', subject, body, template_id, include_properties}]
  db.run(`
    CREATE TABLE IF NOT EXISTS drip_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // one row per contact moving through a drip
  db.run(`
    CREATE TABLE IF NOT EXISTS drip_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drip_id INTEGER,
      client_id INTEGER,
      status TEXT DEFAULT 'active',   -- active | completed | removed | failed
      current_step INTEGER DEFAULT 0, -- next step index to send
      next_run_at TEXT,
      entered_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      last_error TEXT,
      source TEXT,                    -- manual | automation
      automation_id INTEGER
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_drip_due ON drip_enrollments(status, next_run_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_drip_client ON drip_enrollments(drip_id, client_id)') } catch {}
  // AI Suggested Follow-Up — one cached recommendation + FUB dossier per client
  db.run(`
    CREATE TABLE IF NOT EXISTS followup_recommendations (
      client_id INTEGER PRIMARY KEY,
      data TEXT,
      fub_data TEXT,
      fingerprint TEXT,
      analyzed_at TEXT
    )
  `)
  // Inbox AI — one cached suggested reply + intent + user draft per conversation.
  // based_on_msg_id = the latest incoming message the suggestion was built for
  // (a newer incoming makes it stale). draft = the user's edited reply, preserved.
  db.run(`
    CREATE TABLE IF NOT EXISTS inbox_ai (
      client_id INTEGER PRIMARY KEY,
      based_on_msg_id INTEGER,
      intent TEXT,
      summary TEXT,
      suggestion TEXT,
      draft TEXT,
      updated_at TEXT
    )
  `)
  // Scheduled one-to-one texts. A background tick sends any that are due, after a
  // fresh compliance re-check at send time. status: scheduled|sent|canceled|failed.
  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_texts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      phone TEXT,
      body TEXT,
      media_url TEXT,
      send_at TEXT NOT NULL,
      timezone TEXT,
      status TEXT DEFAULT 'scheduled',
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      sent_comm_id INTEGER,
      error TEXT
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_texts(status, send_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sched_client ON scheduled_texts(client_id, status)') } catch {}
  // idempotency: one successful send per (enrollment, step)
  db.run(`
    CREATE TABLE IF NOT EXISTS drip_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_id INTEGER,
      drip_id INTEGER,
      step_index INTEGER,
      idempotency_key TEXT UNIQUE,
      status TEXT DEFAULT 'success',  -- success | failed
      sent_at TEXT DEFAULT (datetime('now')),
      error TEXT
    )
  `)

  // ---- INBOX / COMMUNICATIONS: unified feed of calls, texts, emails, voicemails ----
  // Lean by design: store a short preview + provider id; full bodies stay light
  // (only client-matched incoming items are ever stored). Populated going forward.
  db.run(`
    CREATE TABLE IF NOT EXISTS communications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT,             -- email | text | call | voicemail
      direction TEXT,           -- incoming | outgoing
      client_id INTEGER,        -- matched hub client (rows only stored when matched)
      contact_name TEXT,        -- denormalized for display
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      preview TEXT,             -- short snippet for the list
      body TEXT,                -- optional fuller content (texts/short msgs); may be null
      external_id TEXT UNIQUE,  -- provider message id (dedupe)
      thread_key TEXT,          -- conversation grouping key
      status TEXT DEFAULT 'unread',  -- unread | read | closed
      has_attachment INTEGER DEFAULT 0,
      occurred_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_comm_status ON communications(status, occurred_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_comm_client ON communications(client_id, occurred_at DESC)') } catch {}
  // Communications metadata for the full CRM comms center (2026-08-19). Safe,
  // additive migrations — each is a no-op if the column already exists.
  for (const [col, type] of [
    ['delivery_status', 'TEXT'],   // text: queued|sent|delivered|undelivered|failed ; call: initiated|ringing|in-progress|completed|busy|no-answer|failed|canceled|missed
    ['duration_sec', 'INTEGER'],   // call length
    ['recording_url', 'TEXT'],     // voicemail / call recording media
    ['recording_sid', 'TEXT'],
    ['transcript', 'TEXT'],        // voicemail transcription
    ['disposition', 'TEXT'],       // agent-selected call outcome
    ['notes', 'TEXT'],             // call notes
    ['media_url', 'TEXT'],         // MMS media (json array)
    ['error_message', 'TEXT'],     // friendly failure reason
    ['agent', 'TEXT'],             // which hub user handled it
    ['campaign_id', 'INTEGER'],    // links a sent text to a bulk campaign
  ]) { try { db.run(`ALTER TABLE communications ADD COLUMN ${col} ${type}`) } catch {} }
  try { db.run('CREATE INDEX IF NOT EXISTS idx_comm_sid ON communications(external_id)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_comm_campaign ON communications(campaign_id)') } catch {}
  // Bulk text campaigns — an auditable record of each blast + its recipient math.
  db.run(`
    CREATE TABLE IF NOT EXISTS text_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      created_by TEXT,
      body TEXT,
      template_id INTEGER,
      total INTEGER DEFAULT 0,
      queued INTEGER DEFAULT 0,
      excluded_no_phone INTEGER DEFAULT 0,
      excluded_stop INTEGER DEFAULT 0,
      excluded_dnc INTEGER DEFAULT 0,
      excluded_dup INTEGER DEFAULT 0,
      status TEXT DEFAULT 'sending',
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `)
  // Power Dialer call-list log — one row per call outcome logged in the dialer.
  db.run(`
    CREATE TABLE IF NOT EXISTS dialer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      contact_name TEXT,
      phone TEXT,
      disposition TEXT,
      notes TEXT,
      agent TEXT,
      occurred_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_dialer_when ON dialer_log(occurred_at)') } catch {}
  // Saved voicemail recordings (managed on the Templates tab) — reusable for
  // live-call voicemail drops and as the voicemail greeting.
  db.run(`
    CREATE TABLE IF NOT EXISTS voicemails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // Team agent directory — used for conversation assignment and to add a teammate
  // to a client text. Seeded once with the current roster.
  db.run(`
    CREATE TABLE IF NOT EXISTS team_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try {
    if ((db.get('SELECT COUNT(*) n FROM team_agents')?.n || 0) === 0) {
      for (const a of [['Matt Smith', '319-431-5859', 'Broker Associate'], ['Hunter Caves', '319-447-7337', 'Realtor'], ['John Solamo', '319-343-1562', '']])
        db.run('INSERT INTO team_agents (name, phone, title) VALUES (?,?,?)', a)
    }
  } catch {}

  // =====================================================================
  // Individual user accounts + RBAC + system audit log (Phase 1 foundation).
  // Additive and backwards compatible: the legacy shared TEAM_PASSWORD login
  // keeps working (issues an owner-scoped team token). Per-user accounts add
  // attributable identity + least-privilege on top. Never store plaintext.
  // =====================================================================
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT,                       -- null = invited, password not set yet
      role TEXT NOT NULL DEFAULT 'agent',       -- owner|admin|agent|transaction_coordinator|isa|marketing|read_only
      status TEXT NOT NULL DEFAULT 'active',    -- active|disabled|invited
      two_factor_enabled INTEGER DEFAULT 0,
      two_factor_secret TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT,
      password_changed_at TEXT
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,                       -- session id (jti carried in the token)
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT,
      expires_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      revoked_at TEXT
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      actor TEXT,                                -- display label: email/name, or 'team' for legacy shared login
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      metadata_json TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)') } catch {}
  // Failure visibility log (Phase 16 / P0-3): failed sends, AI actions, syncs, backups.
  // Nothing should be silently lost — every failure is recorded and surfaced to admins.
  db.run(`
    CREATE TABLE IF NOT EXISTS failed_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,              -- sms|email|ai_action|sync|automation|bulk|backup
      ref TEXT,                        -- related id (client_id, campaign_id, ...)
      summary TEXT,                    -- short human description
      payload_json TEXT,
      last_error TEXT,
      retry_count INTEGER DEFAULT 0,   -- times this same failure recurred
      state TEXT DEFAULT 'open',       -- open|resolved
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_failed_state ON failed_jobs(state, kind)') } catch {}
  // Lead routing (P1-6). Built but INERT: routing_enabled defaults off and no trigger
  // auto-routes, so nothing happens until an owner configures rules and turns it on.
  db.run(`
    CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 100,        -- lower = evaluated first
      conditions_json TEXT,                -- { sources:[],cities:[],zips:[],types:[],statuses:[],tags_any:[],price_min,price_max }
      method TEXT DEFAULT 'round_robin',   -- round_robin | weighted | specific
      targets_json TEXT,                   -- [{ agent:'Matt Smith', weight:1 }]
      rr_cursor INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS routing_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      previous_owner TEXT,
      new_owner TEXT,
      rule_id INTEGER,
      rule_name TEXT,
      reason TEXT,
      source TEXT,                         -- routing | user | system
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_routing_hist_client ON routing_history(client_id)') } catch {}
  // Group texting via Twilio Conversations (true group MMS). A group message and every
  // reply share a conversation_sid, so the Inbox can render them as ONE thread.
  try { db.run('ALTER TABLE communications ADD COLUMN conversation_sid TEXT') } catch {}
  try { db.run('ALTER TABLE communications ADD COLUMN group_meta TEXT') } catch {}   // JSON: { participants:[{phone,name}] }
  try { db.run('CREATE INDEX IF NOT EXISTS idx_comm_conversation ON communications(conversation_sid)') } catch {}
  // Landline / undeliverable SMS: set when a send hard-fails (carrier landline/unknown
  // handset). Automated texts skip these; cleared automatically if the contact ever texts us.
  try { db.run('ALTER TABLE clients ADD COLUMN sms_undeliverable INTEGER DEFAULT 0') } catch {}
  try { db.run('ALTER TABLE clients ADD COLUMN sms_undeliverable_reason TEXT') } catch {}
  try { db.run('ALTER TABLE clients ADD COLUMN sms_undeliverable_at TEXT') } catch {}
  // Add username to an already-created users table (idempotent). SQLite unique
  // indexes treat NULLs as distinct, so accounts without a username coexist.
  try { db.run('ALTER TABLE users ADD COLUMN username TEXT') } catch {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)') } catch {}

  // =====================================================================
  // HUB AI ISA — foundation tables (Stage 1). No autonomous behavior until
  // the feature flags are turned on. AI state is SEPARATE from CRM status.
  // =====================================================================
  // Normalized communication permission model. hub_text_opt_out remains the
  // legacy hard block; this layer adds independent do_not_text / do_not_call,
  // consent provenance, and per-lead AI enable/pause. See server/ai-followup/policy.js.
  db.run(`
    CREATE TABLE IF NOT EXISTS communication_preferences (
      client_id INTEGER PRIMARY KEY,
      phone_e164 TEXT,
      sms_status TEXT DEFAULT 'unknown',        -- unknown|eligible|consented|opted_out|blocked
      sms_consent_source TEXT,
      sms_consent_type TEXT,
      sms_consent_timestamp TEXT,
      sms_consent_evidence TEXT,
      sms_opt_out_timestamp TEXT,
      sms_opt_out_source TEXT,
      sms_opt_in_timestamp TEXT,
      do_not_text INTEGER DEFAULT 0,
      do_not_call INTEGER DEFAULT 0,
      voice_consent_status TEXT DEFAULT 'unknown',
      ai_text_enabled INTEGER DEFAULT 1,
      ai_voice_enabled INTEGER DEFAULT 0,
      ai_followup_paused INTEGER DEFAULT 0,
      ai_pause_reason TEXT,
      preferred_channel TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // Per-lead AI state machine (what HUB AI should be doing) — distinct from sales stage.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_lead_state (
      client_id INTEGER PRIMARY KEY,
      ai_state TEXT DEFAULT 'NEW_UNCONTACTED',
      ai_enabled INTEGER DEFAULT 1,
      ai_state_changed_at TEXT DEFAULT (datetime('now')),
      ai_last_action_at TEXT,
      ai_next_action_at TEXT,
      ai_last_inbound_at TEXT,
      ai_last_outbound_at TEXT,
      ai_last_human_contact_at TEXT,
      ai_pause_until TEXT,
      ai_pause_reason TEXT,
      ai_owner TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // Structured, persistent lead memory (buyer/seller preferences + rolling summary).
  db.run(`
    CREATE TABLE IF NOT EXISTS lead_intelligence (
      client_id INTEGER PRIMARY KEY,
      lead_type TEXT,
      intent_score INTEGER DEFAULT 0,
      intent_level TEXT DEFAULT 'LOW',
      intent_reason_json TEXT,
      buying_timeframe TEXT,
      selling_timeframe TEXT,
      price_min INTEGER,
      price_max INTEGER,
      preferred_cities TEXT,
      preferred_neighborhoods TEXT,
      bedrooms_min INTEGER,
      bathrooms_min REAL,
      property_types TEXT,
      must_haves TEXT,
      deal_breakers TEXT,
      financing_status TEXT,
      preapproved INTEGER,
      needs_to_sell_first INTEGER,
      current_housing TEXT,
      preferred_contact_method TEXT,
      preferred_contact_time TEXT,
      working_with_agent INTEGER,
      seller_property_address TEXT,
      seller_motivation TEXT,
      seller_condition_notes TEXT,
      seller_price_expectation TEXT,
      last_property_discussed TEXT,
      properties_of_interest_json TEXT,
      objections_json TEXT,
      motivation_summary TEXT,
      ai_summary TEXT,
      confidence_json TEXT,
      last_extracted_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  // Intent decay (P1-3): remember the historical peak so a lead hot months ago but quiet
  // since shows a decayed CURRENT intent while its peak stays visible for context.
  try { db.run('ALTER TABLE lead_intelligence ADD COLUMN peak_intent INTEGER') } catch {}
  // Conversation classifier (P1-2): a single-word classification of what this lead is
  // in the conversation (buyer/seller/both/investor/renter/past_client/unknown), written
  // by the same model call that produces memory — no extra API round-trip.
  try { db.run('ALTER TABLE lead_intelligence ADD COLUMN conversation_type TEXT') } catch {}
  // Per-field structured memory provenance (P1-2): each learned fact records where it came
  // from, how confident we are, and when. lead_intelligence holds the current value; this
  // holds the evidence trail so a low-confidence guess never silently overwrites a hard fact.
  db.run(`
    CREATE TABLE IF NOT EXISTS lead_memory_fields (
      client_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      source TEXT DEFAULT 'ai',          -- ai | deterministic | import | human
      confidence REAL DEFAULT 0.6,       -- 0..1
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (client_id, field)
    )
  `)
  // Normalized lead-event log (CRM + website + comms events the AI reacts to).
  db.run(`
    CREATE TABLE IF NOT EXISTS lead_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      event_type TEXT NOT NULL,
      event_source TEXT,
      event_timestamp TEXT DEFAULT (datetime('now')),
      metadata_json TEXT,
      processed_by_ai INTEGER DEFAULT 0,
      processed_at TEXT,
      dedup_key TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_leadevt_client ON lead_events(client_id, event_timestamp)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_leadevt_type ON lead_events(event_type, event_timestamp)') } catch {}
  // Full audit of every autonomous AI action ("why did AI send this?").
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      event_id INTEGER,
      action_type TEXT,
      ai_state_before TEXT,
      ai_state_after TEXT,
      model_name TEXT,
      prompt_version TEXT,
      reason TEXT,
      context_summary TEXT,
      tool_calls_json TEXT,
      output_text TEXT,
      intent_before INTEGER,
      intent_after INTEGER,
      tokens_input INTEGER,
      tokens_output INTEGER,
      latency_ms INTEGER,
      status TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_aiact_client ON ai_actions(client_id, created_at)') } catch {}
  // High-intent handoffs → the AI Opportunities queue.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      assigned_to TEXT,
      urgency TEXT DEFAULT 'high',
      reason TEXT,
      summary TEXT,
      recommended_action TEXT,
      intent_score INTEGER,
      status TEXT DEFAULT 'open',            -- open|acknowledged|contacted|resolved|expired
      created_at TEXT DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      completed_at TEXT
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_handoff_queue ON ai_handoffs(status, urgency, created_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_handoff_agent ON ai_handoffs(assigned_to, status)') } catch {}
  // AI regression eval (P1-1): saved runs of the scenario suite. Each run scores every
  // scenario 0-2 against a rubric with hard auto-fails (ignored STOP, hallucination,
  // steering, fair-housing). Gates broad Autopilot; supports prompt/model-version diff.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      model TEXT,
      prompt_version TEXT,
      total INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      autofails INTEGER DEFAULT 0,
      avg_score REAL DEFAULT 0,
      pass_rate REAL DEFAULT 0,
      notes TEXT,
      status TEXT DEFAULT 'complete'         -- running|complete|error
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_eval_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      scenario_id TEXT,
      segment TEXT,                          -- buyer|seller
      title TEXT,
      score INTEGER,                         -- 0|1|2
      autofail TEXT,                         -- null or the failure reason
      action TEXT,
      message TEXT,
      checks_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_eval_results_run ON ai_eval_results(run_id)') } catch {}
  // Durable scheduled AI actions (proactive/nurture) — restart-safe, idempotent.
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_scheduled_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      action_type TEXT,
      execute_at TEXT,
      timezone TEXT,
      state TEXT DEFAULT 'pending',          -- pending|processing|completed|canceled|failed
      reason TEXT,
      payload_json TEXT,
      dedup_key TEXT UNIQUE,
      attempt_count INTEGER DEFAULT 0,
      locked_at TEXT,
      completed_at TEXT,
      canceled_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_aisched_due ON ai_scheduled_actions(state, execute_at)') } catch {}
  // Intent score history (explainable, trended).
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_intent_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      score INTEGER,
      level TEXT,
      reasons_json TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_intent_client ON ai_intent_history(client_id, created_at)') } catch {}
  // AI attribution on the existing communications rows (no parallel message table).
  for (const [col, type] of [['sent_by_type', 'TEXT'], ['ai_action_id', 'INTEGER']]) {
    try { db.run(`ALTER TABLE communications ADD COLUMN ${col} ${type}`) } catch {}
  }
  // Admin quality rating on an AI action (good | needs_work | incorrect | unsafe).
  try { db.run('ALTER TABLE ai_actions ADD COLUMN rating TEXT') } catch {}
  // Explicit per-lead AI enrollment. In manual mode (autopilot off), AI only acts on
  // leads an agent turned on here. Autopilot on = AI may act on all eligible leads.
  try { db.run('ALTER TABLE ai_lead_state ADD COLUMN ai_managed INTEGER DEFAULT 0') } catch {}

  // inbound event queue (property_viewed, contact_created, tag_added, ...)
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      client_id INTEGER,
      dedupe_key TEXT UNIQUE,            -- prevents the same real-world event enrolling twice
      payload TEXT,
      occurred_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_autoevents_unprocessed ON automation_events(processed_at)') } catch {}

  // =============================================
  // NOTES
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      color TEXT DEFAULT 'default',
      pinned INTEGER DEFAULT 0,
      related_type TEXT,
      related_id INTEGER,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // MARKETING CAMPAIGNS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS marketing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT,
      status TEXT DEFAULT 'planned',
      platform TEXT,
      budget REAL,
      spent REAL DEFAULT 0,
      leads_generated INTEGER DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      target_audience TEXT,
      description TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // VENDORS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      contact_name TEXT,
      category TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      website TEXT,
      address TEXT,
      city TEXT,
      state TEXT DEFAULT 'IA',
      rating INTEGER DEFAULT 0,
      preferred INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // PARTNERS (agents, lenders, title companies, etc.)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS partners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT,
      role TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      website TEXT,
      address TEXT,
      city TEXT,
      state TEXT DEFAULT 'IA',
      specialty TEXT,
      relationship_level TEXT DEFAULT 'contact',
      referral_count INTEGER DEFAULT 0,
      last_referral_date TEXT,
      preferred INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // SOCIAL MEDIA CALENDAR
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      platform TEXT NOT NULL,
      post_type TEXT,
      content TEXT,
      media_url TEXT,
      scheduled_date TEXT,
      scheduled_time TEXT,
      status TEXT DEFAULT 'draft',
      listing_id INTEGER,
      campaign_id INTEGER,
      hashtags TEXT,
      engagement_likes INTEGER DEFAULT 0,
      engagement_comments INTEGER DEFAULT 0,
      engagement_shares INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Social publishing columns (n8n connector). Additive migration.
  //  - image_file:      filename of an uploaded image on the persistent disk,
  //                     served publicly at /api/social-media/img/<file> so
  //                     Meta/LinkedIn/etc. can fetch it by URL.
  //  - targets:         JSON array of the pages/platforms to publish to.
  //  - publish_status:  idle | queued | posting | posted | failed  (the n8n
  //                     pipeline state, separate from the calendar `status`).
  //  - published_at:    ISO timestamp the publish completed.
  //  - publish_results: JSON [{platform, ok, post_id, url, error}] from n8n.
  try {
    const spCols = db.all('PRAGMA table_info(social_posts)').map(r => r.name)
    const spNew = [
      ['image_file', 'TEXT'],
      ['targets', 'TEXT'],
      ['publish_status', "TEXT DEFAULT 'idle'"],
      ['published_at', 'TEXT'],
      ['publish_results', 'TEXT'],
    ]
    for (const [col, def] of spNew) {
      if (!spCols.includes(col)) {
        db.run(`ALTER TABLE social_posts ADD COLUMN ${col} ${def}`)
        console.log(`[migration] Added social_posts.${col}`)
      }
    }
  } catch (e) { console.error('[migration] social_posts columns failed:', e.message) }

  // =============================================
  // BLOG POSTS (mattsmithteam.com blog calendar — mirrors social_posts)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT,
      category TEXT,
      status TEXT DEFAULT 'draft',      -- draft | scheduled | posted | planned
      post_date TEXT,                   -- YYYY-MM-DD publish / scheduled date
      post_time TEXT,
      live_url TEXT,                    -- direct link to the published post
      tags TEXT,
      cover_url TEXT,
      meta_title TEXT,
      meta_description TEXT,
      author TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug)') } catch {}

  // =============================================
  // FUB ACTIVITY (web/property activity pulled from Follow Up Boss, matched to a client)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS fub_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fub_event_id INTEGER UNIQUE,
      client_id INTEGER,
      fub_person_id INTEGER,
      type TEXT,
      page_title TEXT,
      page_url TEXT,
      page_duration INTEGER,
      prop_street TEXT,
      prop_city TEXT,
      prop_state TEXT,
      prop_mls TEXT,
      prop_price TEXT,
      occurred_at TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_fub_activity_client ON fub_activity(client_id, occurred_at DESC)') } catch {}
  try { db.run('ALTER TABLE fub_activity ADD COLUMN prop_zip TEXT') } catch {}

  // =============================================
  // CALENDAR EVENTS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      location TEXT,
      description TEXT,
      attendees TEXT,
      related_type TEXT,
      related_id INTEGER,
      reminder_minutes INTEGER DEFAULT 30,
      recurring TEXT,
      color TEXT DEFAULT 'blue',
      completed INTEGER DEFAULT 0,
      google_event_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // LEAD ACTIVITY (tracking pixel beacons from mattsmithteam.com)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS lead_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      sierra_lead_id INTEGER,
      sierra_email TEXT,
      event_type TEXT NOT NULL,
      page_url TEXT,
      page_title TEXT,
      referrer TEXT,
      listing_mls TEXT,
      duration_sec INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `)
  // FUB linkage — used by the realist-score/last-visit syncs (UPDATE/SELECT WHERE fub_person_id).
  // Without this each of ~19k updates full-scans 45k clients, which times out the bulk endpoint.
  try { db.run('CREATE INDEX IF NOT EXISTS idx_clients_fub_person ON clients(fub_person_id)') } catch {}
  db.run('CREATE INDEX IF NOT EXISTS idx_lead_activity_client    ON lead_activity(client_id, created_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_lead_activity_sierra    ON lead_activity(sierra_lead_id, created_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_lead_activity_created   ON lead_activity(created_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_lead_activity_listing   ON lead_activity(listing_mls, created_at DESC)')

  // =============================================
  // SHOWINGS
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS showings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      address TEXT NOT NULL,
      city TEXT,
      mls_number TEXT,
      showing_date TEXT,
      showing_time TEXT,
      feedback TEXT,
      interest_level TEXT,
      list_price REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `)

  // =============================================
  // ACTIVITY LOG
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // CLIENT LISTS (saved filtered groups)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS client_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      filter_criteria TEXT,
      is_dynamic INTEGER DEFAULT 1,
      client_ids TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // LISTINGS - unified pre-listing + active listing with full property data
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_address TEXT NOT NULL,
      city TEXT,
      state TEXT DEFAULT 'IA',
      zip TEXT,
      mls_number TEXT,
      stage TEXT NOT NULL DEFAULT 'pre_listing',
      status TEXT NOT NULL DEFAULT 'New',
      list_price REAL,
      original_list_price REAL,
      bedrooms INTEGER,
      bathrooms_full INTEGER,
      bathrooms_half INTEGER,
      square_feet INTEGER,
      lot_size TEXT,
      year_built INTEGER,
      property_type TEXT,
      garage_spaces INTEGER,
      stories INTEGER,
      basement TEXT,
      heating TEXT,
      cooling TEXT,
      flooring TEXT,
      schools TEXT,
      hoa_fee REAL,
      hoa_frequency TEXT,
      taxes REAL,
      features TEXT,
      photos TEXT,
      hero_photo TEXT,
      virtual_tour_url TEXT,
      mls_link TEXT,
      description TEXT,
      seller_name TEXT,
      seller_phone TEXT,
      seller_email TEXT,
      list_date TEXT,
      under_contract_date TEXT,
      closing_date TEXT,
      open_house_date TEXT,
      open_house_time TEXT,
      marketing_blog_post TEXT,
      marketing_social_instagram TEXT,
      marketing_social_facebook TEXT,
      marketing_coming_soon TEXT,
      marketing_just_listed TEXT,
      marketing_open_house TEXT,
      marketing_email_blast TEXT,
      marketing_price_reduction TEXT,
      marketing_listing_description TEXT,
      marketing_tasks TEXT,
      client_id INTEGER,
      pre_listing_id INTEGER,
      transaction_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `)

  // =============================================
  // REALIST PROPERTIES (tax/AVM data from Realist exports)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS realist_properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_address TEXT NOT NULL,
      address_normalized TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      county TEXT,
      owner_first_name TEXT,
      owner_last_name TEXT,
      owner_name_2 TEXT,
      owner_occupied INTEGER DEFAULT 0,
      market_value REAL,
      assessed_value REAL,
      total_assessment REAL,
      last_sale_price REAL,
      last_sale_date TEXT,
      last_price_per_sqft REAL,
      building_type TEXT,
      style TEXT,
      year_built INTEGER,
      bedrooms INTEGER,
      bathrooms_full INTEGER,
      bathrooms_total TEXT,
      sell_score INTEGER,
      mls_status TEXT,
      subdivision TEXT,
      school_district TEXT,
      township TEXT,
      zoning TEXT,
      raw_json TEXT,
      imported_at TEXT DEFAULT (datetime('now'))
    )
  `)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_realist_addrnorm ON realist_properties(address_normalized)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_realist_zip ON realist_properties(zip)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_realist_sellscore ON realist_properties(sell_score)') } catch {}

  // =============================================
  // EMAIL LOG
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      to_email TEXT NOT NULL,
      from_email TEXT,
      from_name TEXT,
      subject TEXT,
      body TEXT,
      template TEXT,
      status TEXT DEFAULT 'sent',
      provider TEXT DEFAULT 'sendgrid',
      provider_message_id TEXT,
      error TEXT,
      sent_by TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    )
  `)

  // =============================================
  // TEMPLATES (email, text, scripts)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'email',
      category TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      is_html INTEGER DEFAULT 0,
      tags TEXT,
      used_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // TRANSACTION DIGEST LOG (one row per fired daily digest)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS digest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_date TEXT NOT NULL,
      period TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      recipients TEXT,
      transaction_count INTEGER,
      action_count INTEGER,
      success INTEGER DEFAULT 1,
      error TEXT,
      UNIQUE(digest_date, period)
    )
  `)

  // =============================================
  // APP SETTINGS (key-value store for runtime config
  // like the Slack webhook URL — kept OUT of source control)
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // =============================================
  // SIERRA SYNC LOG
  // =============================================
  db.run(`
    CREATE TABLE IF NOT EXISTS sierra_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT,
      leads_synced INTEGER DEFAULT 0,
      leads_added INTEGER DEFAULT 0,
      leads_updated INTEGER DEFAULT 0,
      errors TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // Migration: add new client columns if missing (for existing databases)
  try {
    const cols = db.all("PRAGMA table_info(clients)").map(r => r.name)
    const newCols = [
      ['visits', 'INTEGER DEFAULT 0'],
      ['email_status', 'TEXT'],
      ['phone_status', 'TEXT'],
      ['sierra_update_date', 'TEXT'],
      ['sierra_creation_date', 'TEXT'],
      ['pond_id', 'INTEGER'],
      ['marketing_email_opt_out', 'INTEGER DEFAULT 0'],
      ['text_opt_out', 'INTEGER DEFAULT 0'],
      // Hub-specific hard text block: set ONLY when a contact replies STOP to OUR Hub
      // number. Unlike text_opt_out (synced from Sierra, informational), this is never
      // overwritten by sync and is the sole thing that blocks outbound texting. Calling
      // is never blocked by any opt-out.
      ['hub_text_opt_out', 'INTEGER DEFAULT 0'],
      ['ealert_opt_out', 'INTEGER DEFAULT 0'],
      // FSBO master-file status (Available | Off Market), synced from the FSBO master
      // Google Sheet by phone match. Drives the Hub FSBO list + its status column.
      ['fsbo_status', 'TEXT'],
      ['fsbo_status_at', 'TEXT'],
      ['short_summary', 'TEXT'],
      ['tags', 'TEXT'],
      ['lender_name', 'TEXT'],
      ['lender_status', 'TEXT'],
      ['listing_agent_status', 'TEXT'],
      ['search_price_min', 'REAL'],
      ['search_price_max', 'REAL'],
      ['search_beds_min', 'INTEGER'],
      ['search_baths_min', 'INTEGER'],
      ['search_sqft_min', 'INTEGER'],
      ['search_regions', 'TEXT'],
      ['search_property_types', 'TEXT'],
      ['has_saved_search', 'INTEGER DEFAULT 0'],
      // Realist enrichment fields
      ['realist_market_value', 'REAL'],
      ['realist_assessed_value', 'REAL'],
      ['realist_year_built', 'INTEGER'],
      ['realist_bedrooms', 'INTEGER'],
      ['realist_bathrooms_full', 'INTEGER'],
      ['realist_owner_occupied', 'INTEGER'],
      ['realist_sell_score', 'INTEGER'],
      ['realist_last_sale_price', 'REAL'],
      ['realist_last_sale_date', 'TEXT'],
      ['realist_property_id', 'INTEGER'],
      ['realist_matched_at', 'TEXT'],
      // Follow Up Boss matched person id (for pulling FUB activity)
      ['fub_person_id', 'INTEGER'],
      // Denormalized "last FUB web visit" for the Clients list column + sorting
      ['last_fub_activity_at', 'TEXT'],
      ['last_fub_activity_type', 'TEXT'],
      ['last_fub_activity_detail', 'TEXT'],
      // Cities of the properties this lead has viewed in FUB ("where they're looking")
      ['fub_viewed_cities', 'TEXT'],
      // Free social enrichment (FUB socialData + Gravatar + agent-verified paste)
      ['linkedin_url', 'TEXT'],
      ['facebook_url', 'TEXT'],
      ['avatar_url', 'TEXT'],
      ['job_title', 'TEXT'],
      ['employer', 'TEXT'],
      ['enriched_at', 'TEXT'],
      ['enrichment_source', 'TEXT'],
      // FUB "At a Glance" price: avg price of the homes this lead viewed, computed
      // from their FUB events and stored so {{price_point}} is instant per send.
      ['fub_price_point', 'TEXT'],
      ['fub_price_enriched_at', 'TEXT'],
      // Original lead registration date, recovered from FUB (the Sierra sync lost
      // it — Sierra only carries the date it first imported the lead last year).
      ['register_date', 'TEXT'],
    ]
    for (const [name, type] of newCols) {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE clients ADD COLUMN ${name} ${type}`)
        console.log(`[migration] Added clients.${name}`)
      }
    }
  } catch (e) {
    console.error('[migration] Client columns failed:', e.message)
  }

  // Migration: add notes_log + completed_at to tasks
  try {
    const taskCols = db.all("PRAGMA table_info(tasks)").map(r => r.name)
    if (!taskCols.includes('notes_log')) {
      db.run('ALTER TABLE tasks ADD COLUMN notes_log TEXT')
      console.log('[migration] Added tasks.notes_log')
    }
    if (!taskCols.includes('completed_at')) {
      db.run('ALTER TABLE tasks ADD COLUMN completed_at TEXT')
      console.log('[migration] Added tasks.completed_at')
      // Backfill: any task already in 'done' gets stamped with its updated_at as a best-guess completion time
      db.run("UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL")
    }
    // 2026-07 due time + timed Slack reminders + calendar invite tracking
    for (const [name, type] of [
      ['due_time', 'TEXT'],                       // HH:MM (24h), Central time
      ['reminder_30_sent', 'INTEGER DEFAULT 0'],  // 30-min Slack reminder fired
      ['reminder_5_sent', 'INTEGER DEFAULT 0'],   // 5-min Slack reminder fired
      ['calendar_invited', 'TEXT'],               // stores the datetime we last sent an invite for (re-invite if it changes)
    ]) {
      if (!taskCols.includes(name)) {
        db.run(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`)
        console.log(`[migration] Added tasks.${name}`)
      }
    }
  } catch (e) {
    console.error('[migration] tasks columns failed:', e.message)
  }

  // Migration: add new transaction columns (earnest money due, IPI, lender, dotloop)
  try {
    const cols = db.all("PRAGMA table_info(transactions)").map(r => r.name)
    const newTxCols = [
      ['earnest_money_due_date', 'TEXT'],
      ['ipi_due_date', 'TEXT'],
      ['lender_name', 'TEXT'],
      ['lender_company', 'TEXT'],
      ['lender_email', 'TEXT'],
      ['dotloop_status', "TEXT DEFAULT 'Not Submitted'"],
      ['has_insurance_contingency', 'INTEGER DEFAULT 1'],
      ['has_home_warranty', 'INTEGER DEFAULT 1'],
      // Expanded under-contract checklist (added 2026-05-08)
      ['closing_time', 'TEXT'],
      ['closing_location', 'TEXT'],
      ['closing_time_confirmed', 'INTEGER DEFAULT 0'],
      ['closing_location_confirmed', 'INTEGER DEFAULT 0'],
      ['closing_attendees_notified', 'INTEGER DEFAULT 0'],
      ['closing_disclosure_reviewed', 'INTEGER DEFAULT 0'],
      ['wire_instructions_sent', 'INTEGER DEFAULT 0'],
      ['seller_signed_deed', 'INTEGER DEFAULT 0'],
      ['mls_pending_marked', 'INTEGER DEFAULT 0'],
      ['mls_sold_marked', 'INTEGER DEFAULT 0'],
      ['sellers_disclosure_received', 'INTEGER DEFAULT 0'],
      ['hoa_docs_provided', 'INTEGER DEFAULT 0'],
      ['keys_remotes_collected', 'INTEGER DEFAULT 0'],
      ['sign_lockbox_removed', 'INTEGER DEFAULT 0'],
      ['commission_received', 'INTEGER DEFAULT 0'],
      ['thank_you_gift_sent', 'INTEGER DEFAULT 0'],
      ['referral_followup_30day', 'INTEGER DEFAULT 0'],
      // 2026-05-08 follow-ups
      ['buyer_payment_method', 'TEXT'],
      ['financing_release_followup', 'INTEGER DEFAULT 0'],
      // 2026-05-11 closing-invite auto-send tracking
      ['closing_invite_signature', 'TEXT'],
      ['closing_invite_sent_at', 'TEXT'],
      // 2026-05-13 final-walkthrough scheduling
      ['final_walkthrough_time', 'TEXT'],
      ['final_walkthrough_location', 'TEXT'],
      ['final_walkthrough_invite_signature', 'TEXT'],
      ['final_walkthrough_invite_sent_at', 'TEXT'],
      ['final_walkthrough_confirmed', 'INTEGER DEFAULT 0'],
      // 2026-05-13 buyer financing approval status (separate from financing_release)
      ['financing_status', 'TEXT'],
      // 2026-07-09 marketing checklist on the transaction (consolidated from the
      // retired Listings tab). JSON: { taskKey: { done: bool } }. Auto-cleared
      // when the transaction moves to Under Contract.
      ['marketing_tasks', 'TEXT'],
      // 2026-07-10 seller prepaids / credit on under-contract deals (Yes/No + amount)
      ['seller_prepaids', 'TEXT'],
      ['seller_prepaids_amount', 'TEXT'],
      // 2026-08-12 home warranty payer (CRAAR line 132: seller | buyer | none).
      // has_home_warranty stays as the on/off flag; this records WHO pays so the
      // buyer email says the right thing instead of always "paid by the seller".
      ['home_warranty_paid_by', "TEXT DEFAULT 'seller'"],
      // 2026-08-12 earnest money AMOUNT — split out of earnest_money_deposit,
      // which is (and stays) the collection STATUS. They previously shared one
      // field, so setting the status erased the dollar amount the PA extractor
      // had written in. Now the amount has its own home.
      ['earnest_money_amount', 'TEXT'],
    ]
    for (const [name, type] of newTxCols) {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE transactions ADD COLUMN ${name} ${type}`)
        console.log(`[migration] Added transactions.${name}`)
        // Backfill warranty payer from the existing on/off flag so nothing changes
        // for current rows: warranty off -> 'none', otherwise keep seller-paid.
        if (name === 'home_warranty_paid_by') {
          db.run("UPDATE transactions SET home_warranty_paid_by = 'none' WHERE has_home_warranty = 0")
        }
        // Recover any dollar amount sitting in the status field into the new amount
        // column, then normalize the status back to a valid value so the dropdown
        // and checklist work again.
        if (name === 'earnest_money_amount') {
          db.run("UPDATE transactions SET earnest_money_amount = earnest_money_deposit WHERE earnest_money_deposit LIKE '$%' OR earnest_money_deposit GLOB '[0-9]*'")
          db.run("UPDATE transactions SET earnest_money_deposit = 'Not Started' WHERE earnest_money_deposit IS NOT NULL AND earnest_money_deposit NOT IN ('Not Started','In Progress','Completed')")
        }
      }
    }
  } catch (e) {
    console.error('[migration] transactions new cols failed:', e.message)
  }

  // Campaign-match enrollment tracking: record WHY + the match score when a
  // contact is enrolled via AI Campaign Match (the "records why/when" requirement).
  try {
    const deCols = db.all('PRAGMA table_info(drip_enrollments)').map(r => r.name)
    if (!deCols.includes('enroll_reason')) db.run('ALTER TABLE drip_enrollments ADD COLUMN enroll_reason TEXT')
    if (!deCols.includes('match_score')) db.run('ALTER TABLE drip_enrollments ADD COLUMN match_score INTEGER')
  } catch (e) { console.error('[migration] drip_enrollments campaign-match cols failed:', e.message) }

  // People on a transaction — many-to-many so a deal can carry multiple leads
  // (e.g. two family members buying together). The transaction keeps its single
  // primary client_id for comms; this table is the full roster with roles.
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS transaction_people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        client_id INTEGER,               -- null when added as a free-text name only
        name TEXT,                       -- display name (from client or typed)
        role TEXT DEFAULT 'buyer',       -- buyer | co-buyer | seller | co-seller | other
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id)
      )
    `)
    db.run('CREATE INDEX IF NOT EXISTS idx_txpeople_tx ON transaction_people(transaction_id)')
  } catch (e) {
    console.error('[migration] transaction_people failed:', e.message)
  }

  // Migration: add marketing_tasks column to listings if missing
  try {
    const cols = db.all("PRAGMA table_info(listings)").map(r => r.name)
    if (!cols.includes('marketing_tasks')) {
      db.run('ALTER TABLE listings ADD COLUMN marketing_tasks TEXT')
      console.log('[migration] Added listings.marketing_tasks')
    }
  } catch (e) {
    console.error('[migration] listings.marketing_tasks failed:', e.message)
  }

  // Migration: add marketing_tasks column to pre_listings — the same unified
  // marketing checklist (JSON) shown in the pre-listing popup and on Active
  // transactions.
  try {
    const cols = db.all("PRAGMA table_info(pre_listings)").map(r => r.name)
    if (!cols.includes('marketing_tasks')) {
      db.run('ALTER TABLE pre_listings ADD COLUMN marketing_tasks TEXT')
      console.log('[migration] Added pre_listings.marketing_tasks')
    }
  } catch (e) {
    console.error('[migration] pre_listings.marketing_tasks failed:', e.message)
  }

  // DISABLED 2026-05-11: this migration was permanently failing because its
  // hardcoded new schema (~55 cols) no longer matches the current transactions
  // table (~80+ cols after later ALTER ADD COLUMN migrations). Every failed
  // boot was re-running a half-written BEGIN TRANSACTION block, which caused
  // the persistent DB file on Render to become malformed over time. The
  // agency_type CHECK constraint, if still present, is harmless — agency_type
  // only ever takes a few specific values and we don't write disallowed ones.
  // Leaving the block below behind a constant `false` guard so the historical
  // intent is documented but the code path is dead.
  // eslint-disable-next-line no-constant-condition
  if (false) try {
    const tableInfo = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'")
    const sql = tableInfo[0]?.values[0]?.[0] || ''
    if (sql.includes("agency_type TEXT CHECK")) {
      console.log('[migration] Removing agency_type CHECK constraint from transactions table...')
      db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE transactions RENAME TO transactions_old;
        CREATE TABLE transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          property_address TEXT NOT NULL,
          mls_number TEXT,
          type TEXT NOT NULL DEFAULT 'purchase',
          source TEXT,
          buyer_name TEXT,
          buyers_agent_name TEXT,
          seller_name TEXT,
          sellers_agent_name TEXT,
          agency_type TEXT,
          property_status TEXT NOT NULL DEFAULT 'Active',
          list_price REAL,
          purchase_price REAL,
          contract_date TEXT,
          closing_date TEXT,
          mortgage_contingency_date TEXT,
          appraisal_contingency_date TEXT,
          appraisal_contingency_status TEXT DEFAULT 'Not Started',
          inspection_contingency_date TEXT,
          financing_release TEXT,
          final_walkthrough TEXT,
          inspection_release TEXT,
          final_inspection_waiver TEXT,
          type_of_finance TEXT,
          remove_listing_alerts INTEGER DEFAULT 0,
          email_contract_closing INTEGER DEFAULT 0,
          ayse_added_to_loop INTEGER DEFAULT 0,
          ayse_contracts_signed INTEGER DEFAULT 0,
          earnest_money_deposit TEXT DEFAULT 'Not Started',
          home_inspection TEXT DEFAULT 'Not Started',
          home_inspector TEXT,
          inspection_date TEXT,
          whole_property_inspection INTEGER DEFAULT 0,
          radon_test INTEGER DEFAULT 0,
          wdi_inspection INTEGER DEFAULT 0,
          septic_inspection INTEGER DEFAULT 0,
          well_inspection INTEGER DEFAULT 0,
          sewer_inspection INTEGER DEFAULT 0,
          seller_acknowledgment INTEGER DEFAULT 0,
          abstract TEXT,
          title_commitment TEXT,
          mortgage_payoff TEXT,
          alta_statement TEXT,
          deed_package TEXT,
          utilities_set INTEGER DEFAULT 0,
          sales_worksheet_added INTEGER DEFAULT 0,
          submit_loop_review INTEGER DEFAULT 0,
          approved_commission INTEGER DEFAULT 0,
          closing_complete INTEGER DEFAULT 0,
          testimonial_request INTEGER DEFAULT 0,
          client_id INTEGER,
          tc_assigned TEXT,
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO transactions SELECT * FROM transactions_old;
        DROP TABLE transactions_old;
        COMMIT;
      `)
      console.log('[migration] Done.')
    }
  } catch (e) {
    console.error('[migration] Failed:', e.message)
  }

  // ---- LAYER 4: post-migration integrity check ----
  // Confirm the DB is still healthy after migrations. If it isn't, log
  // loudly but don't crash — Render's health probe (LAYER 5) will refuse
  // to route traffic to a sick instance, preserving the prior good one.
  try {
    const result = db.pragma('integrity_check', { simple: true })
    if (result && result !== 'ok') {
      console.error(`[db] !!! INTEGRITY CHECK FAILED AFTER MIGRATIONS: ${result}`)
    } else {
      console.log('[db] integrity check: ok')
    }
  } catch (e) {
    console.error(`[db] integrity check threw: ${e.message}`)
  }

  saveDb()
  return db
}

// Run a named migration exactly once. Records success in the _migrations
// table. If it throws, the migration is NOT marked applied — fix the bug,
// redeploy, it'll retry next boot. Callers must ensure their migration is
// idempotent so a retry is safe.
export function runMigration(name, fn, opts = {}) {
  if (!db) throw new Error('runMigration called before initDb')
  const existing = db.get('SELECT name FROM _migrations WHERE name = ?', [name])
  if (existing) return { skipped: true, name }
  try {
    fn()
    db.run('INSERT INTO _migrations (name, notes) VALUES (?, ?)', [name, opts.notes || null])
    console.log(`[migration] applied: ${name}`)
    return { applied: true, name }
  } catch (err) {
    console.error(`[migration] FAILED: ${name} — ${err.message}`)
    throw err
  }
}

// Health: cheap DB liveness check for /api/health. Returns ok=false if the
// DB can't be queried, so Render's health probe drops the instance.
// IMPORTANT: must use the wrapper `get()` function below, NOT db.get() - the
// `db` variable holds the raw sql.js Database instance which has no .get()
// method. The bug was causing every Render health probe to fail with
// "db.get is not a function", which kept the service in a degraded routing
// state and made all requests slow.
export function checkDbHealth() {
  if (!db) return { ok: false, error: 'db not initialized' }
  try {
    const c = get('SELECT COUNT(*) as c FROM clients').c
    return { ok: true, clients: c }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Bulk mode: batch a long-running set of writes (e.g. a Sierra sync or a Realist
// CSV import) into ONE SQLite transaction. With better-sqlite3 each write already
// goes straight to the .db file, but wrapping a batch in a single BEGIN/COMMIT is
// far faster (one fsync at the end instead of one per row) and atomic. Depth-
// counted so nested begin/end calls don't fight. If the process dies mid-batch,
// SQLite rolls the uncommitted transaction back on next open — never a partial DB.
export function beginBulk() {
  if (_bulkDepth === 0) { try { db._raw.exec('BEGIN') } catch {} }
  _bulkDepth++
}
export function endBulk() {
  if (_bulkDepth > 0) {
    _bulkDepth--
    if (_bulkDepth === 0) {
      try { db._raw.exec('COMMIT') }
      catch { try { db._raw.exec('ROLLBACK') } catch {} }
    }
  }
}
export function inBulkMode() { return _bulkDepth > 0 }

// No-op. better-sqlite3 writes every change straight to the .db file (rollback-
// journal mode, synchronous FULL) so data is already durable on disk the instant
// a statement runs. Kept as a function because ~200 call sites + endBulk() call
// it. The old sql.js path re-serialized the ENTIRE 65 MB database to a temp file
// on every single write — the root of the memory pressure + event-loop freezes.
export function saveDb() { /* durable-on-write; nothing to flush */ }

// Save status endpoint helper - reports persistence state
export function getDbStatus() {
  let fileExists = false
  let fileSize = 0
  let lastModified = null
  try {
    if (existsSync(DB_PATH)) {
      fileExists = true
      const stats = statSync(DB_PATH)
      fileSize = stats.size
      lastModified = stats.mtime.toISOString()
    }
  } catch (e) {}
  return {
    db_path: DB_PATH,
    db_dir: DB_DIR,
    db_dir_env: process.env.DB_DIR || null,
    file_exists: fileExists,
    file_size_kb: Math.round(fileSize / 1024),
    last_modified: lastModified,
    is_persistent: !!process.env.DB_DIR,
  }
}

// Richer DB diagnostics for the admin System Health panel (Phase 15 / P0-4):
// integrity, journal mode, size, migration count, and recent scheduler write errors.
// Uses PRAGMA quick_check (fast) on the live file; full integrity is checked on backups.
export function getDbHealth() {
  const status = getDbStatus()
  const out = { ...status, size_mb: Math.round((status.file_size_kb / 1024) * 100) / 100 }
  const pragma = (name) => { try { const r = get(`PRAGMA ${name}`); return r ? Object.values(r)[0] : null } catch { return null } }
  out.quick_check = (() => { try { const r = get('PRAGMA quick_check'); return r ? Object.values(r)[0] : null } catch (e) { return 'error: ' + e.message } })()
  out.integrity_ok = out.quick_check === 'ok'
  out.journal_mode = pragma('journal_mode')
  out.page_count = pragma('page_count')
  out.page_size = pragma('page_size')
  out.freelist_count = pragma('freelist_count')
  try { out.migrations = get('SELECT COUNT(*) n FROM _migrations')?.n ?? null } catch { out.migrations = null }
  try { out.tables = get("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'")?.n ?? null } catch { out.tables = null }
  try { out.clients = get('SELECT COUNT(*) n FROM clients')?.n ?? null } catch { out.clients = null }
  try { out.recent_sync_errors = get("SELECT COUNT(*) n FROM sierra_sync_log WHERE errors IS NOT NULL AND errors != '' AND synced_at >= datetime('now','-1 day')")?.n ?? 0 } catch { out.recent_sync_errors = null }
  out.ok = out.file_exists && out.integrity_ok
  return out
}

export function all(sql, params = []) { return db.all(sql, params) }

export function get(sql, params = []) { return db.get(sql, params) }

export function run(sql, params = []) { return db.run(sql, params) }

// --- App settings key-value helpers (runtime config, not in source control) ---
export function getSetting(key, fallback = null) {
  try {
    const row = get('SELECT value FROM app_settings WHERE key = ?', [key])
    return row ? row.value : fallback
  } catch { return fallback }
}
export function setSetting(key, value) {
  run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, value])
}

export default { all, get, run, initDb, saveDb, beginBulk, endBulk, inBulkMode, runMigration, checkDbHealth, getSetting, setSetting }
