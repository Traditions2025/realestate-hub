// Cancelled/Expired Connection Campaign API (see server/cx-connect.js).
import { Router } from 'express'
import db from '../database.js'
import { enrollClient, enrollList, pauseCampaign, resumeCampaign, removeFromCampaign, campaignState, campaignStats, cxEnabled } from '../cx-connect.js'

const router = Router()

router.get('/stats', (_req, res) => { try { res.json(campaignStats()) } catch (e) { res.status(500).json({ error: e.message }) } })

// Master switch. OFF by default; enabling it is a deliberate action.
router.post('/toggle', (req, res) => {
  try {
    const on = req.body?.enabled ? '1' : '0'
    db.setSetting('cx_campaign_enabled', on)
    res.json({ ok: true, enabled: on === '1' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Bulk enroll the Cancelled/Expired saved list (each lead eligibility-checked).
router.post('/enroll-list', async (_req, res) => {
  try { res.json(await enrollList()) } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/:clientId', (req, res) => {
  try { res.json({ ...campaignState(Number(req.params.clientId)), enabled: cxEnabled() }) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/:clientId/enroll', async (req, res) => {
  try { res.json(await enrollClient(Number(req.params.clientId), req.user?.email || 'manual')) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/:clientId/pause', (req, res) => {
  try { res.json({ ok: true, state: pauseCampaign(Number(req.params.clientId)) }) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/:clientId/resume', async (req, res) => {
  try { res.json(await resumeCampaign(Number(req.params.clientId))) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/:clientId/remove', (req, res) => {
  try { res.json(removeFromCampaign(Number(req.params.clientId))) } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
