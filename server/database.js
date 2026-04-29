import initSqlJs from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
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

  if (existsSync(DB_PATH)) {
    const stats = statSync(DB_PATH)
    console.log(`[db] Loading existing database (${(stats.size / 1024).toFixed(1)} KB, modified ${stats.mtime.toISOString()})`)
    const buffer = readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  } else {
    console.log(`[db] No existing database, creating new at ${DB_PATH}`)
    db = new SQL.Database()
  }

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

  // Migration: drop agency_type CHECK constraint if it exists
  // SQLite doesn't allow ALTER TABLE DROP CONSTRAINT, so we have to recreate the table
  try {
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

  saveDb()
  return db
}

let saveErrorLogged = false
export function saveDb() {
  if (!db) return
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(DB_PATH, buffer)
    saveErrorLogged = false
  } catch (e) {
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
  saveDb()
  return { lastInsertRowid: lastId, changes }
}

export default { all, get, run, initDb, saveDb }
