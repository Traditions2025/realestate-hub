// Facebook Ads tracking API (Marketing > Facebook Ads tab).
import { Router } from 'express'
import { fbAdsOverview, syncFbAds, saveFbToken } from '../fb-ads.js'

const router = Router()

router.get('/', (_req, res) => {
  try { res.json(fbAdsOverview()) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/sync', async (_req, res) => {
  try { res.json(await syncFbAds()) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/token', async (req, res) => {
  try { res.json(await saveFbToken(req.body?.token)) } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
