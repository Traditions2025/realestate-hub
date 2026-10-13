// /api/editorial: the Listing Marketing Machine's editorial engine.
// See server/editorial/engine.js for the pipeline.
import { Router } from 'express'
import db from '../database.js'
import { CHANNELS, TONES, LENGTHS, ANGLES, OPENING_APPROACHES, FEEDBACK_PRESETS } from '../editorial/rules.js'
import { STAGES } from '../editorial/engine.js'
import { lintCopy } from '../editorial/lint.js'
import { buildFactSheet } from '../editorial/facts.js'
import { isConfigured, EDITORIAL_MODEL } from '../editorial/model.js'
import * as store from '../editorial/store.js'
import { startFromAddress } from '../editorial/autofill.js'
import { startPackage, getJob, startRun, getRunForClient, applyVersion, selectionAlternatives, loadListing, editorialSettings } from '../editorial/service.js'

const router = Router()
const who = (req) => req.user?.email || req.user?.name || null
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })

router.get('/meta', (_req, res) => {
  res.json({
    configured: isConfigured(),
    model: EDITORIAL_MODEL,
    channels: Object.entries(CHANNELS).map(([key, c]) => ({ key, label: c.label, column: c.column, multi: c.versions.length > 1 })),
    tones: Object.entries(TONES).map(([key, t]) => ({ key, label: t.label })),
    lengths: Object.entries(LENGTHS).map(([key, l]) => ({ key, label: l.label, words: l.words })),
    angles: Object.entries(ANGLES).map(([key, label]) => ({ key, label })),
    openings: Object.entries(OPENING_APPROACHES).map(([key, o]) => ({ key, label: o.label })),
    feedback_presets: FEEDBACK_PRESETS.map(p => ({ key: p.key, text: p.text })),
    library_labels: store.LIBRARY_LABELS,
    stages: STAGES,
    settings: editorialSettings(),
  })
})

router.put('/settings', (req, res) => {
  const { mls_char_limit, market_context } = req.body || {}
  if (mls_char_limit !== undefined) {
    const n = Number(mls_char_limit)
    if (!(n >= 200 && n <= 5000)) return res.status(400).json({ error: 'mls_char_limit must be 200 to 5000' })
    db.setSetting('editorial_mls_char_limit', String(n))
  }
  if (market_context !== undefined) db.setSetting('editorial_market_context', String(market_context).slice(0, 4000))
  res.json(editorialSettings())
})

// --- Start from an address ---------------------------------------------------
// One typed address -> research (assessor, team files and photos, listing sites) -> writing.
// scope: 'mls' (MLS remarks only) or 'package' (every channel). Poll /jobs/:id for progress.
router.post('/start', (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  const { address, scope = 'mls', settings = {} } = req.body || {}
  if (!String(address || '').trim()) return res.status(400).json({ error: 'address required' })
  const job = startPackage({ address, scope, settings, user: who(req), startFromAddress })
  res.status(202).json({ job_id: job.id })
})

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'This job is no longer in memory (the app restarted). The listing and any finished copy are saved; open it from the list.' })
  res.json(job)
})

// --- Runs ------------------------------------------------------------------
router.post('/listings/:id/runs', (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  try {
    const { channel = 'mls', settings = {} } = req.body || {}
    const { runId, promise } = startRun({ listingId: Number(req.params.id), channel, input: settings, user: who(req) })
    promise.catch(() => {}) // failure is recorded on the run row
    res.status(202).json({ run_id: runId })
  } catch (e) { fail(res, e) }
})

router.get('/runs/:id', (req, res) => {
  const r = getRunForClient(req.params.id)
  if (!r) return res.status(404).json({ error: 'Run not found' })
  res.json(r)
})

router.get('/listings/:id/runs/latest', (req, res) => {
  const r = store.latestRun(Number(req.params.id), req.query.channel || 'mls')
  res.json(r || null)
})

router.post('/runs/:id/apply', (req, res) => {
  try { res.json(applyVersion({ runId: Number(req.params.id), label: req.body?.label, text: req.body?.text, user: who(req) })) } catch (e) { fail(res, e) }
})

// --- Rewrite a selected passage ---------------------------------------------
router.post('/listings/:id/rewrite-selection', async (req, res) => {
  if (!isConfigured()) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  try {
    const { channel = 'mls', full_text, selection, instruction, settings } = req.body || {}
    const alternatives = await selectionAlternatives({ listingId: Number(req.params.id), channel, fullText: full_text, selection, instruction, input: settings || {} })
    res.json({ alternatives })
  } catch (e) { fail(res, e) }
})

// --- Live check (no model) --------------------------------------------------
router.post('/lint', (req, res) => {
  const { text, channel = 'mls', listing_id } = req.body || {}
  const listing = listing_id ? loadListing(listing_id) : null
  const facts = listing ? buildFactSheet(listing) : null
  res.json(lintCopy(text || '', {
    channel,
    facts: facts?.text,
    address: facts?.record.street_address,
    charLimit: channel === 'mls' ? editorialSettings().mls_char_limit : null,
    customRules: store.listRules({ activeOnly: true, channel }),
  }))
})

// --- Version history ----------------------------------------------------------
router.get('/listings/:id/versions', (req, res) => {
  res.json(store.listVersions(Number(req.params.id), req.query.channel || 'mls'))
})

router.post('/listings/:id/versions/:vid/restore', (req, res) => {
  const v = store.getVersion(req.params.vid)
  if (!v || v.listing_id !== Number(req.params.id)) return res.status(404).json({ error: 'Version not found' })
  const column = CHANNELS[v.channel]?.column
  if (!column) return res.status(400).json({ error: 'Unknown channel' })
  db.run(`UPDATE listings SET ${column} = ?, updated_at = ? WHERE id = ?`, [v.content, new Date().toISOString(), v.listing_id])
  store.addVersion({ listingId: v.listing_id, channel: v.channel, content: v.content, source: 'restore', label: `restored #${v.id}`, user: who(req) })
  res.json({ content: v.content, column })
})

// --- Reference library ---------------------------------------------------------
router.get('/library', (req, res) => {
  res.json(store.listLibrary({ channel: req.query.channel, label: req.query.label }))
})

// Approve copy into the library. With listing_id + channel, the current saved text is the
// approved version and the last AI version is captured as the original draft, so the edit
// is on record.
router.post('/library', (req, res) => {
  try {
    const b = req.body || {}
    const channel = b.channel || 'mls'
    let approved = b.approved_text
    let original = b.original_draft || null
    let propertyType = b.property_type || null
    let positioning = b.price_positioning || null
    let keyChars = b.key_characteristics || null
    if (b.listing_id) {
      const l = loadListing(b.listing_id)
      if (!l) return res.status(404).json({ error: 'Listing not found' })
      approved = approved || l[CHANNELS[channel].column]
      original = original || store.lastAiVersion(l.id, channel)?.content || null
      const run = store.latestRun(l.id, channel)
      propertyType = propertyType || run?.analysis?.property_category || l.property_type
      positioning = positioning || (run?.analysis?.positioning || []).map(p => p.category).join('; ') || null
      keyChars = keyChars || (run?.analysis?.top_selling_points || []).join('; ') || null
    }
    if (!approved || !String(approved).trim()) return res.status(400).json({ error: 'No text to approve' })
    const id = store.addLibraryEntry({
      listing_id: b.listing_id, channel, property_type: propertyType, price_positioning: positioning, key_characteristics: keyChars,
      tone: b.tone, approved_text: String(approved).trim(), original_draft: original,
      human_edits: original && original !== approved ? 'edited' : (original ? 'unchanged' : null),
      edit_reasons: b.edit_reasons, label: b.label, approved_by: who(req),
    })
    res.status(201).json({ id })
  } catch (e) { fail(res, e) }
})

router.put('/library/:id', (req, res) => {
  try { store.updateLibraryEntry(req.params.id, req.body || {}); res.json({ success: true }) } catch (e) { fail(res, Object.assign(e, { status: 400 })) }
})

router.delete('/library/:id', (req, res) => {
  store.deleteLibraryEntry(req.params.id)
  res.json({ success: true })
})

// --- Team rules + audit history ------------------------------------------------
router.get('/rules', (_req, res) => res.json(store.listRules()))
router.get('/rules/history', (_req, res) => res.json(store.ruleHistoryList()))

router.post('/rules', (req, res) => {
  try {
    const b = req.body || {}
    const id = store.createRule({ ...b, source: b.feedback_key ? 'feedback' : 'manual', user: who(req) })
    res.status(201).json(store.getRule(id))
  } catch (e) { fail(res, Object.assign(e, { status: 400 })) }
})

router.put('/rules/:id', (req, res) => {
  try { res.json(store.updateRule(req.params.id, req.body || {}, { reason: req.body?.reason, user: who(req) })) } catch (e) { fail(res, Object.assign(e, { status: 400 })) }
})

// --- Feedback --------------------------------------------------------------------
router.post('/feedback', (req, res) => {
  const { listing_id, run_id, channel, text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' })
  const key = store.addFeedback({ listingId: listing_id, runId: run_id, channel, text, user: who(req) })
  res.json({ key, summary: store.feedbackSummary().find(s => s.feedback_key === key) })
})

router.get('/feedback', (_req, res) => res.json(store.feedbackSummary()))

export default router
