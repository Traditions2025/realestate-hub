// FSBO Connect - Off Market: read + control endpoints.
//
// Everything the dashboard in §20/§23/§24 needs is here, so the UI is a rendering job and
// nothing has to be recomputed in the browser. Every write is explicit; the only thing that
// sends a text is the sweep, and the sweep refuses to run while the master switch is off.
import { Router } from 'express'
import db from '../database.js'
import * as OM from '../fsbo-offmarket.js'

const router = Router()

// ---- read ----------------------------------------------------------------------------
router.get('/stats', (_req, res) => {
  try { res.json(OM.stats()) } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/board', (_req, res) => {
  try { res.json(OM.board()) } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/angles', (_req, res) => {
  try { res.json(OM.anglePerformance()) } catch (e) { res.status(500).json({ error: e.message }) }
})

/** The message library itself, so it can be reviewed without reading the source. */
router.get('/library', (_req, res) => {
  const street = String(req_street(_req) || '{{street}}')
  const sal = '{{salutation}}'
  res.json({
    identification: 'Hi, this is John with Matt Smith Team at RE/MAX.',
    max_attempts: OM.MAX_ATTEMPTS,
    intro: Object.fromEntries(['recent', 'mid', 'old', 'ancient'].map(b => [b, OM.INTRO[b](street, sal)])),
    follow_up: Object.fromEntries(['recent', 'mid', 'old', 'ancient'].map(b => [b, OM.FOLLOW_UP[b](street)])),
    angles: OM.ROTATION.map(k => ({ key: k, buckets: OM.ANGLES[k].buckets, text: OM.ANGLES[k].text(street) })),
  })
})
function req_street(req) { return req?.query?.street }

/** One lead: campaign row, its whole audit trail, and why it would or would not send now. */
router.get('/lead/:clientId', async (req, res) => {
  try {
    const cid = Number(req.params.clientId)
    const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
    const enrollment = db.get('SELECT * FROM fsbo_om_campaign WHERE client_id=?', [cid]) || null
    const log = db.all('SELECT * FROM fsbo_om_log WHERE client_id=? ORDER BY id DESC LIMIT 100', [cid])
    const evaluation = c ? await OM.evaluateEligibility(c, {}) : { ok: false, code: 'HUMAN_REMOVED' }
    res.json({ enrollment, log, evaluation })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/** What the next text would say, for one lead. Writes nothing, sends nothing. */
router.get('/lead/:clientId/preview-next', (req, res) => {
  try {
    const cid = Number(req.params.clientId)
    const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
    if (!c) return res.status(404).json({ error: 'client not found' })
    const en = db.get('SELECT attempt_count FROM fsbo_om_campaign WHERE client_id=?', [cid])
    const attempt = (en?.attempt_count || 0) + 1
    const bucket = OM.ageBucket(OM.listingAgeDays(c))
    if (attempt > OM.MAX_ATTEMPTS) return res.json({ attempt, bucket, capped: true, body: null })
    res.json({ attempt, bucket, capped: false, ...OM.composeFor(c, attempt, bucket) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/** Who the campaign WOULD take, and what each one would get. Zero writes. */
router.get('/preview', async (_req, res) => {
  try {
    const rows = []
    for (const c of OM.eligiblePool()) {
      const ev = await OM.evaluateEligibility(c, { atEnroll: true })
      const bucket = OM.ageBucket(OM.listingAgeDays(c))
      rows.push({
        client_id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        address: c.address, bucket, listing_age_days: OM.listingAgeDays(c), listed: c.fsbo_list_date || null,
        eligible: ev.ok, reason: ev.ok ? null : `${ev.code}: ${ev.detail}`,
        first_text: ev.ok ? OM.composeFor(c, 1, bucket).body : null,
      })
    }
    res.json({ dry_run: true, pool: rows.length, eligible: rows.filter(r => r.eligible).length, rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- control -------------------------------------------------------------------------
router.post('/toggle', (req, res) => {
  const on = req.body?.enabled === true || req.body?.enabled === '1'
  db.setSetting('fsbo_offmarket_enabled', on ? '1' : '0')
  res.json({ enabled: on })
})

router.post('/enroll', async (req, res) => {
  try {
    if (req.body?.client_id) return res.json(await OM.enrollClient(Number(req.body.client_id), req.user?.email || 'agent'))
    res.json(await OM.bulkEnroll())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/** The sweep. dry_run:true evaluates everything and sends nothing. */
router.post('/run', async (req, res) => {
  try {
    res.json(await OM.runSweep({ limit: Math.min(Number(req.body?.limit) || 25, 100), dryRun: req.body?.dry_run === true }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/lead/:clientId/pause', (req, res) => res.json(OM.pause(req.params.clientId, req.user?.email || 'agent')))
router.post('/lead/:clientId/resume', (req, res) => res.json(OM.resume(req.params.clientId, req.user?.email || 'agent')))
router.post('/lead/:clientId/remove', (req, res) => res.json(OM.remove(req.params.clientId, req.user?.email || 'agent', String(req.body?.reason || ''))))

export default router
