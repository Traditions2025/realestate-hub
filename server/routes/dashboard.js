import { Router } from 'express'
import db from '../database.js'

const router = Router()

router.get('/', (req, res) => {
  const stats = {
    transactions: {
      active: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status IN ('Active', 'Under Contract', 'Pending')").count,
      under_contract: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status = 'Under Contract'").count,
      clear_to_close: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status = 'Clear to Close'").count,
      closed_this_month: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status = 'Closed' AND closing_date >= date('now', 'start of month')").count,
      total_volume: db.get("SELECT COALESCE(SUM(purchase_price), 0) as total FROM transactions WHERE property_status = 'Closed' AND closing_date >= date('now', 'start of month')").total,
      purchases: db.get("SELECT COUNT(*) as count FROM transactions WHERE type = 'purchase' AND property_status NOT IN ('Closed', 'Withdrawn', 'Expired', 'Cancelled')").count,
      listings: db.get("SELECT COUNT(*) as count FROM transactions WHERE type = 'listing' AND property_status NOT IN ('Closed', 'Withdrawn', 'Expired', 'Cancelled')").count,
    },
    clients: {
      active_buyers: db.get("SELECT COUNT(*) as count FROM clients WHERE type IN ('buyer', 'both') AND status IN ('active', 'prime')").count,
      active_sellers: db.get("SELECT COUNT(*) as count FROM clients WHERE type IN ('seller', 'both') AND status IN ('active', 'prime')").count,
      active: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").count,
      prime: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'prime'").count,
      potential: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'potential'").count,
      watch: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'watch'").count,
      total: db.get("SELECT COUNT(*) as count FROM clients").count,
    },
    tasks: {
      overdue: db.get("SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date < date('now')").count,
      due_today: db.get("SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date = date('now')").count,
      in_progress: db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'").count,
      total_open: db.get("SELECT COUNT(*) as count FROM tasks WHERE status != 'done'").count,
    },
    projects: {
      active: db.get("SELECT COUNT(*) as count FROM projects WHERE status = 'active'").count,
    },
    pre_listings: {
      total: db.get("SELECT COUNT(*) as count FROM pre_listings").count,
      pending: db.get("SELECT COUNT(*) as count FROM pre_listings WHERE walkthrough = 'Pending'").count,
    },
    marketing: {
      active_campaigns: db.get("SELECT COUNT(*) as count FROM marketing WHERE status = 'active'").count,
      total_budget: db.get("SELECT COALESCE(SUM(budget), 0) as total FROM marketing WHERE status = 'active'").total,
      total_leads: db.get("SELECT COALESCE(SUM(leads_generated), 0) as total FROM marketing WHERE status = 'active'").total,
    },
    social_media: {
      scheduled: db.get("SELECT COUNT(*) as count FROM social_posts WHERE status = 'scheduled' AND scheduled_date >= date('now')").count,
      posted_this_week: db.get("SELECT COUNT(*) as count FROM social_posts WHERE status = 'posted' AND scheduled_date >= date('now', '-7 days')").count,
    },
    vendors: {
      total: db.get("SELECT COUNT(*) as count FROM vendors").count,
      preferred: db.get("SELECT COUNT(*) as count FROM vendors WHERE preferred = 1").count,
    },
    partners: {
      total: db.get("SELECT COUNT(*) as count FROM partners").count,
    },
    calendar: {
      today: db.get("SELECT COUNT(*) as count FROM calendar_events WHERE event_date = date('now')").count,
      this_week: db.get("SELECT COUNT(*) as count FROM calendar_events WHERE event_date BETWEEN date('now') AND date('now', '+7 days')").count,
    }
  }

  stats.recent_activity = db.all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15')
  stats.upcoming_tasks = db.all("SELECT * FROM tasks WHERE status != 'done' ORDER BY CASE WHEN due_date < date('now') THEN 0 ELSE 1 END, due_date ASC LIMIT 10")
  stats.active_transactions = db.all(`SELECT t.*, c.first_name || ' ' || c.last_name as client_name
    FROM transactions t LEFT JOIN clients c ON t.client_id = c.id
    WHERE t.property_status IN ('Active', 'Under Contract', 'Pending', 'Clear to Close')
    ORDER BY t.closing_date ASC LIMIT 10`)
  stats.todays_events = db.all("SELECT * FROM calendar_events WHERE event_date = date('now') ORDER BY start_time ASC")
  stats.last_sierra_sync = db.get('SELECT * FROM sierra_sync_log ORDER BY synced_at DESC LIMIT 1')

  res.json(stats)
})

export default router
