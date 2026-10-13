// Glue between the pipeline and the Hub: loads the listing, runs the job in the
// background with stage progress written to editorial_runs, and applies a chosen version.
import db from '../database.js'
import { CHANNELS } from './rules.js'
import { runPipeline, rewriteSelection, DEFAULT_MLS_CHAR_LIMIT } from './engine.js'
import { buildFactSheet } from './facts.js'
import { callJson as realCallJson, EDITORIAL_MODEL } from './model.js'
import * as store from './store.js'

const STALE_MS = 15 * 60 * 1000

export function loadListing(id) {
  const row = db.get('SELECT * FROM listings WHERE id = ?', [Number(id)])
  if (!row) return null
  try { row.features = JSON.parse(row.features || '[]') } catch { row.features = [] }
  return row
}

export function editorialSettings() {
  return {
    mls_char_limit: Number(db.getSetting('editorial_mls_char_limit', '')) || DEFAULT_MLS_CHAR_LIMIT,
    market_context: db.getSetting('editorial_market_context', '') || '',
  }
}

function depsFor({ listingId, channel, factsHash, callJson = realCallJson, onStage }) {
  const s = editorialSettings()
  return {
    callJson,
    onStage,
    customRules: store.listRules({ activeOnly: true, channel }),
    pickExamples: store.pickExamples,
    marketContext: s.market_context,
    cachedAnalysis: store.cachedAnalysis(listingId, factsHash),
  }
}

/** Start a run. Resolves immediately with the run id; the work continues in the background. */
export function startRun({ listingId, channel, input = {}, user, callJson }) {
  const listing = loadListing(listingId)
  if (!listing) throw Object.assign(new Error('Listing not found'), { status: 404 })
  if (!CHANNELS[channel]) throw Object.assign(new Error(`Unknown channel: ${channel}`), { status: 400 })
  if (channel === 'mls' && !input.charLimit) input = { ...input, charLimit: editorialSettings().mls_char_limit }
  const facts = buildFactSheet(listing, input)
  const runId = store.createRun({ listingId: listing.id, channel, settings: input, factsHash: facts.hash, model: EDITORIAL_MODEL, user })
  db.run('UPDATE listings SET marketing_editorial_settings = ? WHERE id = ?', [JSON.stringify({ ...input, channel }), listing.id])

  const promise = (async () => {
    try {
      const result = await runPipeline({
        listing, channel, input,
        deps: depsFor({
          listingId: listing.id, channel, factsHash: facts.hash, callJson,
          onStage: (stage, partial) => {
            const fields = { stage }
            if (partial.analysis) fields.analysis = partial.analysis
            if (partial.drafts) fields.drafts = partial.drafts
            if (partial.review) fields.review = partial.review
            if (partial.rewrite) fields.rewrite = partial.rewrite
            if (partial.verification) fields.verification = partial.verification
            store.updateRun(runId, fields)
          },
        }),
      })
      store.updateRun(runId, {
        status: 'done', stage: 'done', settings: result.settings, analysis: result.analysis,
        drafts: result.drafts, review: result.review, rewrite: result.rewrite, verification: result.verification,
        final: { ...result.final, examples_used: result.examples_used, usage: result.usage },
        finished_at: new Date().toISOString(),
      })
      return runId
    } catch (e) {
      console.error(`[editorial] run ${runId} failed:`, e.message)
      store.updateRun(runId, { status: 'failed', error: String(e.message || e).slice(0, 500), finished_at: new Date().toISOString() })
      throw e
    }
  })()
  return { runId, promise }
}

export function getRunForClient(id) {
  const r = store.getRun(id)
  if (!r) return null
  const started = new Date(String(r.created_at).replace(' ', 'T') + (String(r.created_at).endsWith('Z') ? '' : 'Z')).getTime()
  if (r.status === 'running' && Date.now() - started > STALE_MS) {
    store.updateRun(r.id, { status: 'failed', error: 'Run did not finish (server restarted or timed out). Start it again.' })
    return store.getRun(id)
  }
  return r
}

/** Write a version of a finished run to the listing's channel column. */
export function applyVersion({ runId, label, text, user }) {
  const run = store.getRun(runId)
  if (!run || run.status !== 'done') throw Object.assign(new Error('Run not finished'), { status: 400 })
  const v = run.final.versions.find(x => x.label === label) || run.final.versions.find(x => x.label === run.final.recommended)
  const content = text && String(text).trim() ? String(text).trim() : v.output
  const column = CHANNELS[run.channel].column
  db.run(`UPDATE listings SET ${column} = ?, updated_at = ? WHERE id = ?`, [content, new Date().toISOString(), run.listing_id])
  store.addVersion({ listingId: run.listing_id, channel: run.channel, content: v.output, source: 'ai', label: v.label, runId: run.id, user })
  if (content !== v.output) store.addVersion({ listingId: run.listing_id, channel: run.channel, content, source: 'human', user })
  return { content, column, label: v.label }
}

export async function selectionAlternatives({ listingId, channel, fullText, selection, instruction, input, callJson = realCallJson }) {
  const listing = loadListing(listingId)
  if (!listing) throw Object.assign(new Error('Listing not found'), { status: 404 })
  if (channel === 'mls' && !input?.charLimit) input = { ...(input || {}), charLimit: editorialSettings().mls_char_limit }
  return rewriteSelection({
    listing, channel, input, fullText, selection, instruction,
    deps: { callJson, customRules: store.listRules({ activeOnly: true, channel }) },
  })
}

// column -> channel, for recording human edits made through the normal listing Save.
export const COLUMN_TO_CHANNEL = Object.fromEntries(Object.entries(CHANNELS).map(([k, c]) => [c.column, k]))

export function recordHumanEdits(listingId, before, after, user) {
  for (const [column, channel] of Object.entries(COLUMN_TO_CHANNEL)) {
    if (!(column in after)) continue
    const prev = before?.[column] || ''
    const next = after[column] || ''
    if (next && next !== prev) store.addVersion({ listingId, channel, content: next, source: 'human', user })
  }
}

// ---------------------------------------------------------------------------
// "Enter an address, get the marketing": research + writing as one job.
// Jobs live in memory (a restart loses the progress view, not the results: runs and the
// listing are in the database).
// ---------------------------------------------------------------------------
export const PACKAGE_CHANNELS = ['mls', 'website', 'premarket_social', 'premarket_email', 'premarket_blog', 'active_social', 'social_facebook', 'social_instagram', 'active_email', 'video_script']
const JOBS = new Map()

export function getJob(id) { return JOBS.get(String(id)) || null }

export function startPackage({ address, scope = 'mls', settings = {}, user, startFromAddress }) {
  const id = Math.random().toString(36).slice(2, 10)
  const channels = scope === 'package' ? PACKAGE_CHANNELS : ['mls']
  const job = {
    id, address, scope, status: 'running', listing_id: null, error: null, created_at: new Date().toISOString(),
    steps: [
      { key: 'address', label: 'Find the property', status: 'pending' },
      { key: 'record', label: 'Public record (assessor)', status: 'pending' },
      { key: 'files', label: "Team's files and photos", status: 'pending' },
      { key: 'web', label: 'Public listing sites', status: 'pending' },
      ...channels.map(c => ({ key: `ch:${c}`, label: CHANNELS[c].label, status: 'pending', channel: c })),
    ],
    runs: {},
  }
  JOBS.set(id, job)
  const step = (key, status, detail, extra = {}) => {
    const s = job.steps.find(x => x.key === key)
    if (s) Object.assign(s, { status, ...(detail !== undefined ? { detail } : {}) })
    if (extra.listing_id) job.listing_id = extra.listing_id
  }

  ;(async () => {
    try {
      const found = await startFromAddress(address, { onStep: step })
      job.listing_id = found.listing_id
      job.found = found
      const runOne = async (channel) => {
        step(`ch:${channel}`, 'running')
        const input = channel === 'mls' ? settings : { tone: settings.tone }
        const { runId, promise } = startRun({ listingId: job.listing_id, channel, input, user })
        job.runs[channel] = runId
        try {
          await promise
          const col = CHANNELS[channel].column
          const current = db.get(`SELECT ${col} AS v FROM listings WHERE id = ?`, [job.listing_id])?.v
          // Fill empty channels automatically; never replace copy that is already there.
          if (!current || !String(current).trim()) { const a = applyVersion({ runId, user }); step(`ch:${channel}`, 'done', `Version ${a.label} saved`) }
          else step(`ch:${channel}`, 'done', 'Written; existing copy kept, pick a version to replace it')
        } catch (e) { step(`ch:${channel}`, 'failed', e.message) }
      }
      await runOne(channels[0])            // MLS first: its analysis is reused by every other channel
      const rest = channels.slice(1)
      const workers = Array.from({ length: Math.min(3, rest.length) }, async () => { while (rest.length) await runOne(rest.shift()) })
      await Promise.all(workers)
      job.status = job.steps.some(s => s.status === 'failed') ? 'done_with_errors' : 'done'
    } catch (e) {
      job.status = 'failed'
      job.error = e.message
      const running = job.steps.find(s => s.status === 'running')
      if (running) Object.assign(running, { status: 'failed', detail: e.message })
    }
  })()
  return job
}
