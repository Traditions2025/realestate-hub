// FACEBOOK ADS TRACKING (John, 2026-09-21): pull campaign performance from the
// Meta Graph API into the Hub so the Marketing tab shows live ad tracking —
// status, start date, daily budget, spend, impressions, reach, clicks, CTR,
// leads, cost per lead, video views, and a last-7-days snapshot per campaign.
//
// Token: a user token from the "Matt Smith Team Reporting" Meta app (Graph API
// Explorer, Leo's FB account, ads_read scope), extended to ~60 days, stored in
// the fb_ads_access_token setting (paste it in the Marketing > Facebook Ads tab).
// When it expires the sync records the error and the tab shows a renewal banner
// instead of stale numbers presented as fresh.
import db from './database.js'

const GRAPH = 'https://graph.facebook.com/v21.0'
const nowIso = () => new Date().toISOString()

export function initFbAds() {
  db.run(`CREATE TABLE IF NOT EXISTS fb_ad_campaigns (
    campaign_id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    effective_status TEXT,
    objective TEXT,
    created_time TEXT,
    start_time TEXT,
    stop_time TEXT,
    daily_budget REAL,
    lifetime_budget REAL,
    budget_remaining REAL,
    spend REAL,
    impressions INTEGER,
    reach INTEGER,
    clicks INTEGER,
    link_clicks INTEGER,
    ctr REAL,
    cpc REAL,
    cpm REAL,
    frequency REAL,
    leads INTEGER,
    cost_per_lead REAL,
    video_views INTEGER,
    last7_json TEXT,
    synced_at TEXT
  )`)
}

const token = () => (db.getSetting?.('fb_ads_access_token', '') || '').trim()
export const fbAdsAccountId = () => (db.getSetting?.('fb_ads_account_id', '') || '').trim() || 'act_616264022369725'

// Pull counts out of the insights "actions" array. Meta reports ONE lead under
// SEVERAL action types at once ('lead' is the canonical total; 'leadgen_grouped'
// and 'onsite_conversion.lead_grouped' are overlapping subsets of it). Summing
// them DOUBLED every lead count (Kitchen creative showed 2 where Ads Manager
// showed 1, caught by John 2026-09-22). Use the canonical total; fall back to
// the largest subset only when 'lead' is absent.
const actionValue = (actions, name) => Number((actions || []).find(a => a.action_type === name)?.value) || 0
export function leadCount(actions) {
  return actionValue(actions, 'lead')
    || Math.max(actionValue(actions, 'leadgen_grouped'), actionValue(actions, 'onsite_conversion.lead_grouped'), actionValue(actions, 'offsite_conversion.fb_pixel_lead'))
}
export const videoViewCount = (actions) => actionValue(actions, 'video_view')

async function graph(path, params = {}) {
  const t = token()
  if (!t) throw Object.assign(new Error('no token'), { code: 'NO_TOKEN' })
  const q = new URLSearchParams({ ...params, access_token: t })
  const r = await fetch(`${GRAPH}/${path}?${q}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = j.error?.message || `HTTP ${r.status}`
    throw Object.assign(new Error(msg), { code: j.error?.code === 190 ? 'TOKEN_EXPIRED' : 'GRAPH_ERROR' })
  }
  return j
}

const INSIGHT_FIELDS = 'impressions,reach,clicks,inline_link_clicks,ctr,cpc,cpm,spend,frequency,actions,cost_per_action_type'

let syncing = false
export async function syncFbAds() {
  if (syncing) return { skipped: 'running' }
  if (!token()) return { skipped: 'no token' }
  syncing = true
  try {
    initFbAds()
    const act = fbAdsAccountId()
    const campaigns = []
    let after = null
    for (let i = 0; i < 10; i++) {
      const page = await graph(`${act}/campaigns`, {
        fields: 'id,name,status,effective_status,objective,created_time,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining',
        limit: '100', ...(after ? { after } : {}),
      })
      campaigns.push(...(page.data || []))
      after = page.paging?.cursors?.after
      if (!page.paging?.next) break
    }
    let synced = 0
    for (const c of campaigns) {
      let life = {}, last7 = {}
      try { life = (await graph(`${c.id}/insights`, { fields: INSIGHT_FIELDS, date_preset: 'maximum' })).data?.[0] || {} } catch {}
      try { last7 = (await graph(`${c.id}/insights`, { fields: 'impressions,clicks,spend,actions', date_preset: 'last_7d' })).data?.[0] || {} } catch {}
      const leads = leadCount(life.actions)
      const spend = Number(life.spend) || 0
      db.run(`INSERT INTO fb_ad_campaigns (campaign_id, name, status, effective_status, objective, created_time, start_time, stop_time,
                daily_budget, lifetime_budget, budget_remaining, spend, impressions, reach, clicks, link_clicks, ctr, cpc, cpm, frequency,
                leads, cost_per_lead, video_views, last7_json, synced_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT (campaign_id) DO UPDATE SET name=excluded.name, status=excluded.status, effective_status=excluded.effective_status,
                objective=excluded.objective, created_time=excluded.created_time, start_time=excluded.start_time, stop_time=excluded.stop_time,
                daily_budget=excluded.daily_budget, lifetime_budget=excluded.lifetime_budget, budget_remaining=excluded.budget_remaining,
                spend=excluded.spend, impressions=excluded.impressions, reach=excluded.reach, clicks=excluded.clicks,
                link_clicks=excluded.link_clicks, ctr=excluded.ctr, cpc=excluded.cpc, cpm=excluded.cpm, frequency=excluded.frequency,
                leads=excluded.leads, cost_per_lead=excluded.cost_per_lead, video_views=excluded.video_views,
                last7_json=excluded.last7_json, synced_at=excluded.synced_at`,
        [c.id, c.name || '', c.status || '', c.effective_status || '', c.objective || '', c.created_time || null, c.start_time || null, c.stop_time || null,
         c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
         c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : null,
         c.budget_remaining != null ? Number(c.budget_remaining) / 100 : null,
         spend, Number(life.impressions) || 0, Number(life.reach) || 0, Number(life.clicks) || 0,
         Number(life.inline_link_clicks) || 0, Number(life.ctr) || 0, Number(life.cpc) || 0, Number(life.cpm) || 0, Number(life.frequency) || 0,
         leads, leads ? +(spend / leads).toFixed(2) : null, videoViewCount(life.actions),
         JSON.stringify({ impressions: Number(last7.impressions) || 0, clicks: Number(last7.clicks) || 0, spend: Number(last7.spend) || 0, leads: leadCount(last7.actions) }),
         nowIso()])
      synced++
    }
    // Account-level last-30-days rollup for the dashboard cards (reach only
    // dedupes properly at account level, so it comes from here, not a sum).
    try {
      const a30 = (await graph(`${act}/insights`, { fields: 'impressions,reach,clicks,spend,actions', date_preset: 'last_30d' })).data?.[0] || {}
      db.setSetting?.('fb_ads_account_30d', JSON.stringify({
        impressions: Number(a30.impressions) || 0, reach: Number(a30.reach) || 0,
        clicks: Number(a30.clicks) || 0, spend: Number(a30.spend) || 0, leads: leadCount(a30.actions),
      }))
    } catch {}
    // Current CALENDAR month to date (John, 2026-09-23): "monthly ad spend" is
    // the month everyone budgets against, which is not the same window as the
    // rolling last-30-days numbers beside it.
    try {
      const am = (await graph(`${act}/insights`, { fields: 'impressions,reach,clicks,spend,actions', date_preset: 'this_month' })).data?.[0] || {}
      db.setSetting?.('fb_ads_account_month', JSON.stringify({
        impressions: Number(am.impressions) || 0, reach: Number(am.reach) || 0,
        clicks: Number(am.clicks) || 0, spend: Number(am.spend) || 0, leads: leadCount(am.actions),
        since: am.date_start || null, until: am.date_stop || null,
      }))
    } catch {}
    db.setSetting?.('fb_ads_last_sync', nowIso())
    db.setSetting?.('fb_ads_token_error', '')
    return { ok: true, campaigns: synced }
  } catch (e) {
    if (e.code === 'TOKEN_EXPIRED' || e.code === 'NO_TOKEN') db.setSetting?.('fb_ads_token_error', e.message)
    return { error: e.message, code: e.code }
  } finally { syncing = false }
}

// Validate a pasted token before saving it (a typo'd token should never
// silently replace a working one).
export async function saveFbToken(newToken) {
  const t = String(newToken || '').trim()
  if (t.length < 40) return { ok: false, error: 'that does not look like a Facebook access token' }
  const r = await fetch(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(t)}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error?.message || `token check failed (${r.status})` }
  db.setSetting?.('fb_ads_access_token', t)
  db.setSetting?.('fb_ads_token_error', '')
  syncFbAds().catch(() => {})
  return { ok: true, as: j.name || j.id }
}

export function fbAdsOverview() {
  initFbAds()
  const rows = db.all('SELECT * FROM fb_ad_campaigns ORDER BY (effective_status=\'ACTIVE\') DESC, start_time DESC')
    .map(r => { let l7 = {}; try { l7 = JSON.parse(r.last7_json || '{}') } catch {}; const { last7_json, ...rest } = r; return { ...rest, last7: l7 } })
  const tot = rows.reduce((a, r) => ({ spend: a.spend + (r.spend || 0), leads: a.leads + (r.leads || 0), impressions: a.impressions + (r.impressions || 0), clicks: a.clicks + (r.clicks || 0) }), { spend: 0, leads: 0, impressions: 0, clicks: 0 })
  // Dashboard cards (John, 2026-09-22): spend of RUNNING campaigns only, plus the
  // account's last-30-days leads / impressions / reach.
  const activeSpend = rows.filter(r => r.effective_status === 'ACTIVE').reduce((s, r) => s + (r.spend || 0), 0)
  let last30 = {}, month = {}
  try { last30 = JSON.parse(db.getSetting?.('fb_ads_account_30d', '{}') || '{}') } catch {}
  try { month = JSON.parse(db.getSetting?.('fb_ads_account_month', '{}') || '{}') } catch {}
  return {
    account_id: fbAdsAccountId(),
    token_present: !!token(),
    token_error: db.getSetting?.('fb_ads_token_error', '') || '',
    last_sync: db.getSetting?.('fb_ads_last_sync', null),
    totals: { ...tot, active: rows.filter(r => r.effective_status === 'ACTIVE').length, campaigns: rows.length, active_spend: +activeSpend.toFixed(2) },
    last30,
    month,
    campaigns: rows,
  }
}
