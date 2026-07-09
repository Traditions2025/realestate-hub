import initSqlJs from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, readdirSync, copyFileSync, openSync, fsyncSync, closeSync, unlinkSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Use persistent disk path on Render if mounted, otherwise local
const DB_DIR = process.env.DB_DIR || join(__dirname, '..')
const DB_PATH = join(DB_DIR, 'realestate-hub.db')

let db

export async function initDb() {
  const SQL = await initSqlJs()

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

    const buffer = readFileSync(DB_PATH)
    try {
      db = new SQL.Database(buffer)
      db.exec('PRAGMA quick_check;')
    } catch (corruptErr) {
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
          const buf = readFileSync(c.path)
          const testDb = new SQL.Database(buf)
          testDb.exec('PRAGMA quick_check;')
          testDb.close()
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
      const restoredBuffer = readFileSync(DB_PATH)
      db = new SQL.Database(restoredBuffer)
      db.exec('PRAGMA quick_check;')
      console.error('[db] !!! Restored DB loaded successfully. Service continuing.')
      console.error('[db] !!! NOTE: any data written between the backup time and the corruption may be in')
      console.error(`[db] !!!       the sidecar at ${corruptAside}. Original corrupt bytes are preserved there.`)
    }
  } else {
    // Truly no DB anywhere — first-ever boot OR Render disk really is empty.
    // This is now a rare path because of the retry+auto-restore above.
    console.log(`[db] No existing database AND no usable backup, creating new at ${DB_PATH}`)
    db = new SQL.Database()
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
    const cols = db.exec("PRAGMA table_info(clients)")[0]?.values.map(v => v[1]) || []
    const newCols = [
      ['visits', 'INTEGER DEFAULT 0'],
      ['email_status', 'TEXT'],
      ['phone_status', 'TEXT'],
      ['sierra_update_date', 'TEXT'],
      ['sierra_creation_date', 'TEXT'],
      ['pond_id', 'INTEGER'],
      ['marketing_email_opt_out', 'INTEGER DEFAULT 0'],
      ['text_opt_out', 'INTEGER DEFAULT 0'],
      ['ealert_opt_out', 'INTEGER DEFAULT 0'],
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
    const taskCols = db.exec("PRAGMA table_info(tasks)")[0]?.values.map(v => v[1]) || []
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
  } catch (e) {
    console.error('[migration] tasks columns failed:', e.message)
  }

  // Migration: add new transaction columns (earnest money due, IPI, lender, dotloop)
  try {
    const cols = db.exec("PRAGMA table_info(transactions)")[0]?.values.map(v => v[1]) || []
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
    ]
    for (const [name, type] of newTxCols) {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE transactions ADD COLUMN ${name} ${type}`)
        console.log(`[migration] Added transactions.${name}`)
      }
    }
  } catch (e) {
    console.error('[migration] transactions new cols failed:', e.message)
  }

  // Migration: add marketing_tasks column to listings if missing
  try {
    const cols = db.exec("PRAGMA table_info(listings)")[0]?.values.map(v => v[1]) || []
    if (!cols.includes('marketing_tasks')) {
      db.run('ALTER TABLE listings ADD COLUMN marketing_tasks TEXT')
      console.log('[migration] Added listings.marketing_tasks')
    }
  } catch (e) {
    console.error('[migration] listings.marketing_tasks failed:', e.message)
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
    const r = db.exec('PRAGMA integrity_check;')
    const result = r[0]?.values[0]?.[0]
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

// Bulk mode: skip saveDb() inside the run() helper during long-running batch ops
// (e.g. Realist CSV import). Caller must explicitly saveDb() when done.
// Without this, a 3000-row import would call saveDb() 6000+ times = entire DB
// written to disk thousands of times = seconds-to-minutes of blocked event loop.
let _bulkMode = false
export function beginBulk() { _bulkMode = true }
export function endBulk() {
  _bulkMode = false
  saveDb()
}
export function inBulkMode() { return _bulkMode }

let saveErrorLogged = false
export function saveDb() {
  if (!db) return
  const tmpPath = `${DB_PATH}.tmp`
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    // ---- ATOMIC SAVE (added 2026-07-07) ----
    // Write the full DB to a temp file, force it to physical disk (fsync),
    // then atomically rename it over the live file. A crash or interruption
    // mid-write can now only ever leave a stray `.tmp` file — the real
    // realestate-hub.db is swapped in a single filesystem operation and is
    // NEVER observed half-written. This is the missing safeguard behind the
    // 2026-05-20 corruption, where a direct writeFileSync onto the live file
    // could truncate it if the process died mid-write. This makes it safe to
    // batch writes with beginBulk()/endBulk() on scheduled syncs.
    const fd = openSync(tmpPath, 'w')
    try {
      writeFileSync(fd, buffer)
      fsyncSync(fd)            // flush bytes to disk BEFORE the rename
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, DB_PATH)  // atomic on the same filesystem (/data)
    saveErrorLogged = false
  } catch (e) {
    // Clean up a partial temp file so it can't be mistaken for a real DB.
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    if (!saveErrorLogged) {
      console.error(`[db] CRITICAL: Failed to save DB to ${DB_PATH}: ${e.message}`)
      console.error(`[db] Your data will be lost on restart. Check that DB_DIR=${DB_DIR} is writable.`)
      saveErrorLogged = true
    }
  }
}

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

export function all(sql, params = []) {
  const stmt = db.prepare(sql)
  if (params.length) stmt.bind(params)
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

export function get(sql, params = []) {
  const rows = all(sql, params)
  return rows[0] || null
}

export function run(sql, params = []) {
  db.run(sql, params)
  const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0]
  const changes = db.getRowsModified()
  if (!_bulkMode) saveDb()
  return { lastInsertRowid: lastId, changes }
}

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
