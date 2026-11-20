// Three-way calling endpoints. See server/conference.js for why the escalation works the
// way it does.
//
// Two routers, because they have opposite security needs and requireAuth decides which is
// which BY PATH: it exempts the whole /api/voice/ prefix so Twilio's signature-validated
// webhooks can reach us unauthenticated. A control a person presses must therefore NOT
// live under /api/voice, or anyone who found the URL could dial a stranger into a live
// client call.
//
//   twimlRouter   -> mounted at /api/voice      Twilio only, signature-guarded
//   controlRouter -> mounted at /api/conference signed-in people only
import { Router } from 'express'
import { twilioWebhookGuard } from '../twilio-webhook.js'
import {
  addToCall, dropLeg, stateFor, pendingRoomFor, clearPending,
  conferenceTwiml, noteConferenceEvent, attachConferenceRecording,
} from '../conference.js'

const hubBase = () => process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const xml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`)

export const twimlRouter = Router()
// Guarded on this router only. Mounting the guard at /api/voice instead would re-run
// signature validation for every existing voice webhook and double-count the telemetry
// the Settings panel reads to decide whether enforcement is safe to switch on.
twimlRouter.use(twilioWebhookGuard)

// The outbound Dial finished. Normally the call is over and we hang up, which is exactly
// what happened implicitly before this endpoint existed. The exception is an escalation to
// three-way: the callee has just been redirected into a room and the agent follows them
// in. Defensive throughout, because a throw here would leave a live caller listening to a
// Twilio error instead of ending their call cleanly.
twimlRouter.post('/outbound-dial-complete', (req, res) => {
  try {
    const sid = req.body?.CallSid || ''
    const room = pendingRoomFor(sid)
    if (room) {
      clearPending(sid)
      return xml(res, conferenceTwiml({ room, hubBase: hubBase(), isAgent: true, label: 'agent' }))
    }
  } catch (e) { console.error('[conference] dial-complete:', e.message) }
  xml(res, '<Hangup/>')
})

// TwiML for any leg joining a room: the redirected callee, and every number added after.
twimlRouter.post('/conference-join', (req, res) => {
  try {
    const room = String(req.query?.room || req.body?.room || '')
    if (!room) return xml(res, '<Say voice="alice">That call is no longer available.</Say><Hangup/>')
    return xml(res, conferenceTwiml({ room, hubBase: hubBase(), label: String(req.query?.label || '').slice(0, 60) }))
  } catch (e) {
    console.error('[conference] join:', e.message)
    xml(res, '<Say voice="alice">Sorry, we could not connect that call.</Say><Hangup/>')
  }
})

// Conference status callback: keeps the roster in the widget honest, because a line can
// drop for reasons the browser never sees.
twimlRouter.post('/conference-status', (req, res) => {
  try { noteConferenceEvent(req.body || {}) } catch (e) { console.error('[conference] status:', e.message) }
  res.sendStatus(204)
})

// Conference recording ready. This is the SECOND half of the audio for a call that was
// escalated, so it never overwrites the two-party recording already on the row.
twimlRouter.post('/conference-recording', (req, res) => {
  try {
    const r = attachConferenceRecording(req.body || {})
    if (r.ok && r.attached_to && Number(req.body?.RecordingDuration || 0) >= 20) {
      import('../call-intelligence.js').then(m => m.queueTranscription(r.attached_to)).catch(e => console.error('[call-intel] queue:', e.message))
    }
  } catch (e) { console.error('[conference] recording:', e.message) }
  res.sendStatus(204)
})

export const controlRouter = Router()

controlRouter.post('/add', async (req, res) => {
  try {
    const out = await addToCall({
      parentSid: String(req.body?.parent_sid || ''),
      number: String(req.body?.number || ''),
      name: String(req.body?.name || ''),
      hubBase: hubBase(),
    })
    res.status(out.ok ? 200 : 400).json(out)
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

controlRouter.post('/drop', async (req, res) => {
  try {
    const out = await dropLeg({ parentSid: String(req.body?.parent_sid || ''), callSid: String(req.body?.call_sid || '') })
    res.status(out.ok ? 200 : 400).json(out)
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

controlRouter.get('/state/:parentSid', (req, res) => {
  try { res.json(stateFor(req.params.parentSid)) }
  catch (e) { res.status(500).json({ conference: false, participants: [], error: e.message }) }
})
