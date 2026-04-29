import { Router } from 'express'
import db from '../database.js'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

// Vendor list embedded - imported once on first run if no vendors exist
const VENDORS = [
  { company_name: 'Corda Credit Union', contact_name: 'Tim Lamb', category: 'Mortgage Lender', phone: '(319) 360-9455', email: 'TLamb@cordacu.org', city: 'Cedar Rapids', preferred: 1 },
  { company_name: 'Residential Mortgage Network', contact_name: 'April Holden', category: 'Mortgage Lender', phone: '(319) 331-7279', email: 'april@rmniowa.com', city: 'Cedar Rapids' },
  { company_name: 'Greenstate Credit Union', contact_name: 'Amber Matson', category: 'Mortgage Lender', phone: '(319) 929-2852', email: 'ambermatson@greenstate.org', city: 'Cedar Rapids' },
  { company_name: 'Cedar Rapids Bank & Trust', contact_name: 'Cody Ritter', category: 'Mortgage Lender', phone: '(319) 899-9946', email: 'critter@crbt.com', city: 'Cedar Rapids' },
  { company_name: 'Hills Bank', contact_name: 'Carly Lefebure', category: 'Mortgage Lender', phone: '(319) 350-5337', email: 'carly_lefebure@hillsbank.com', city: 'Cedar Rapids' },
  { company_name: 'Veridian Credit Union', contact_name: 'Pete Halvorson', category: 'Mortgage Lender', phone: '(319) 743-6487', email: 'PeterCH@VeridianCU.org', city: 'Cedar Rapids' },
  { company_name: 'Ohnward Bank & Trust', contact_name: 'Karen Jahlas', category: 'Mortgage Lender', phone: '(319) 304-5460', email: 'kjahlas@ohnwardbank.com', city: 'Cedar Rapids' },
  { company_name: 'Bankers Trust', contact_name: 'Mike Dupont', category: 'Mortgage Lender', phone: '(319) 533-4308', email: 'mdupont@bankerstrust.com', city: 'Cedar Rapids' },
  { company_name: 'First Federal Credit Union', contact_name: 'Brian Bockenstedt', category: 'Mortgage Lender', phone: '(319) 743-7806', email: 'Brian.Bockenstedt@firstfedcu.com', city: 'Cedar Rapids' },
  { company_name: 'Liberty Enterprises LLC', contact_name: 'Laura Steffeck', category: 'Cleaner', phone: '(319) 350-4546', city: 'Cedar Rapids' },
  { company_name: 'Five Seasons Home Inspections LLC', contact_name: 'Mike Gharib', category: 'Home Inspector', phone: '(319) 540-1840', email: 'mikegharib@gmail.com', website: 'www.5seasonshomeinspections.com', city: 'Cedar Rapids', preferred: 1 },
  { company_name: 'Vigilant Home Inspection', contact_name: 'Roy Wier', category: 'Home Inspector', phone: '(319) 899-7538', email: 'hello@vigilanthome.com', website: 'https://vigilanthome.com/', city: 'Cedar Rapids' },
  { company_name: 'Royal Home Inspections LLC', contact_name: 'Jarad Reddoor', category: 'Home Inspector', phone: '(319) 693-1658', email: 'office@royalhomeinspectionsllc.com', city: 'Cedar Rapids' },
  { company_name: 'A Closer Look LLC', contact_name: 'Andrew Saulnier', category: 'Home Inspector', phone: '319-310-8537', email: 'andrew@inspectcr.com', website: 'https://inspectcr.com/', city: 'Cedar Rapids' },
  { company_name: 'Kevin Hulsing', contact_name: 'Kevin Hulsing', category: 'Handyman', phone: '319-350-6641', city: 'Cedar Rapids' },
  { company_name: 'Caves Services LLC', contact_name: 'Hunter Caves', category: 'Handyman', phone: '(319) 447-7337', city: 'Cedar Rapids' },
  { company_name: 'Nolans Lawn and Landscapes', contact_name: 'Nolan Herlocker', category: 'Landscaper', phone: '319-721-9785', city: 'Cedar Rapids' },
  { company_name: 'HSA Home Warranty', category: 'Home Warranty' },
  { company_name: 'White Glove Movers', category: 'Mover', phone: '(319) 393-3000', email: 'INFO@WHITEGLOVEMOVES.COM', city: 'Cedar Rapids' },
  { company_name: 'TWO MEN AND A TRUCK', category: 'Mover', phone: '(319) 483-6425', city: 'Cedar Rapids' },
  { company_name: 'Alliant Energy', category: 'Utilities', phone: '(800) 255-4268' },
  { company_name: 'Linn County REC', category: 'Utilities', phone: '(319) 377-1587' },
  { company_name: 'MidAmerican Energy', category: 'Utilities', phone: '(888) 427-5632' },
  { company_name: 'City of Cedar Rapids', category: 'Utilities', phone: '(319) 286-5900' },
  { company_name: 'City of Marion', category: 'Utilities', phone: '(319) 743-6310', city: 'Marion' },
  { company_name: 'Heartland Credit Restoration', contact_name: 'Kathy Heggebo', category: 'Credit Restoration', phone: '(319) 373-2822' },
  { company_name: 'Johnson Plumbing', category: 'Plumber', phone: '319-389-0726' },
  { company_name: 'Drop Inn Charity Shop', category: 'Donations', phone: '(319) 396-3164' },
]

const PARTNERS = [
  { name: 'Cherryl', company: 'At Your Service Escrow', role: 'Escrow Officer', preferred: 1 },
]

// Sample/recent calendar events from Matt's Google Calendar (snapshot)
// New events should be added via the "+ New Event" button or future Google Calendar integration
const CALENDAR_SEED = [
  { title: 'Skogman earnest money', event_type: 'Other', event_date: '2026-04-14', start_time: '11:15', end_time: '11:45', color: 'amber' },
  { title: 'Home Inspection - 1033 74th St NE', event_type: 'Inspection', event_date: '2026-04-15', start_time: '10:30', end_time: '11:00', color: 'red' },
  { title: 'Appointment with Jesse Grade', event_type: 'Showing', event_date: '2026-04-15', start_time: '17:00', end_time: '18:00', location: '1110 Regent St NE, Cedar Rapids', color: 'blue' },
  { title: 'Appointment with Gary Doerrfeld', event_type: 'Showing', event_date: '2026-04-15', start_time: '17:15', end_time: '18:15', location: '158 32nd St NW, Cedar Rapids', color: 'blue' },
  { title: 'Show homes Ortiz', event_type: 'Showing', event_date: '2026-04-15', start_time: '17:30', end_time: '19:00', color: 'blue' },
  { title: 'Mortgage Contingency - 400 1st St Se #204', event_type: 'Other', event_date: '2026-04-16', color: 'amber' },
  { title: 'Tim Lamb', event_type: 'Listing Appointment', event_date: '2026-04-16', start_time: '17:00', end_time: '18:45', color: 'green' },
  { title: 'Final Walkthrough - 400 1st St Se #204', event_type: 'Walkthrough', event_date: '2026-04-17', color: 'purple' },
  { title: 'Showing - 1103 26th Street, Marion', event_type: 'Showing', event_date: '2026-04-18', start_time: '10:30', end_time: '11:10', location: '1103 26th Street, Marion, IA 52302', color: 'blue' },
  { title: 'Closing - 400 1st St Se #204', event_type: 'Closing', event_date: '2026-04-20', color: 'green' },
]

function seedVendors() {
  const existing = db.get('SELECT COUNT(*) as count FROM vendors').count
  if (existing > 0) return { skipped: true, reason: 'Vendors already exist', count: existing }

  let added = 0
  for (const v of VENDORS) {
    db.run(`INSERT INTO vendors (company_name, contact_name, category, phone, email, website, city, preferred)
      VALUES (?,?,?,?,?,?,?,?)`,
      [v.company_name, n(v.contact_name), v.category, n(v.phone), n(v.email), n(v.website), n(v.city), v.preferred || 0])
    added++
  }
  return { added }
}

function seedPartners() {
  const existing = db.get('SELECT COUNT(*) as count FROM partners').count
  if (existing > 0) return { skipped: true, count: existing }

  let added = 0
  for (const p of PARTNERS) {
    db.run('INSERT INTO partners (name, company, role, preferred) VALUES (?,?,?,?)',
      [p.name, n(p.company), p.role, p.preferred || 0])
    added++
  }
  return { added }
}

function seedCalendar() {
  const existing = db.get('SELECT COUNT(*) as count FROM calendar_events').count
  if (existing > 0) return { skipped: true, count: existing }

  let added = 0
  for (const e of CALENDAR_SEED) {
    db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time, end_time, location, color)
      VALUES (?,?,?,?,?,?,?)`,
      [e.title, e.event_type, e.event_date, n(e.start_time), n(e.end_time), n(e.location), e.color || 'blue'])
    added++
  }
  return { added }
}

// Setup endpoint - registers Sierra webhooks for real-time updates
router.post('/setup-webhooks', async (req, res) => {
  try {
    const baseUrl = req.body?.baseUrl || `https://${req.headers.host}`
    const webhookUrl = `${baseUrl}/api/sierra/webhook`

    const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/sierra/register-webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': req.headers['x-auth-token'] || '' },
      body: JSON.stringify({ baseUrl }),
    })
    const data = await r.json()
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Run all syncs - vendors, partners, Google Sheet, Sierra
router.post('/all', async (req, res) => {
  const results = { vendors: null, partners: null, calendar: null, transactions: null, prelistings: null, sierra: null }

  try {
    // Vendors (only seeds if empty)
    results.vendors = seedVendors()

    // Partners (only seeds if empty)
    results.partners = seedPartners()

    // Calendar (only seeds if empty)
    results.calendar = seedCalendar()

    // Google Sheet - Transactions
    try {
      const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/transactions/sync-sheet`, {
        method: 'POST',
        headers: { 'x-auth-token': req.headers['x-auth-token'] || '' }
      })
      results.transactions = await r.json()
    } catch (e) { results.transactions = { error: e.message } }

    // Google Sheet - Pre-listings
    try {
      const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/pre-listings/sync-sheet`, {
        method: 'POST',
        headers: { 'x-auth-token': req.headers['x-auth-token'] || '' }
      })
      results.prelistings = await r.json()
    } catch (e) { results.prelistings = { error: e.message } }

    // Sierra (background sync)
    try {
      const r = await fetch(`http://localhost:${process.env.PORT || 3001}/api/sierra/sync`, {
        method: 'POST',
        headers: { 'x-auth-token': req.headers['x-auth-token'] || '' }
      })
      results.sierra = await r.json()
    } catch (e) { results.sierra = { error: e.message } }

    db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
      ['synced', 'all', `Sync Everything: vendors + partners + sheet + Sierra started`])

    res.json({ success: true, results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Auto-seed on first boot - called on server startup
export function autoSeedOnBoot() {
  try {
    const v = seedVendors()
    const p = seedPartners()
    const c = seedCalendar()
    if (v.added) console.log(`  Seeded ${v.added} vendors`)
    if (p.added) console.log(`  Seeded ${p.added} partners`)
    if (c.added) console.log(`  Seeded ${c.added} calendar events`)
  } catch (e) {
    console.error('Auto-seed failed:', e.message)
  }
}

export default router
