// THREE-WAY CALLING (John, 2026-11-20: "I will call Karam Saba then I will dial another
// number while Karam is on the line, the city water department, not on hub list").
//
// WHY THIS IS AN ESCALATION AND NOT THE DEFAULT PATH
//
// An ordinary Hub call is `<Dial><Number>` — two legs bridged together, which cannot hold a
// third person. The obvious fix is to make every outbound call a conference from the start,
// and it was rejected: that would move every real client call, its dual-channel recording,
// the voicemail drop and the call-intelligence pipeline onto a new path at once, to serve a
// case that comes up occasionally. Instead the two-party path is untouched, and pressing
// "Add call" converts THAT call into a conference.
//
// HOW THE CONVERSION WORKS, AND WHY IN THIS ORDER
//
// A `<Dial>` ends the moment either leg leaves, so the order matters:
//
//   1. remember that this call is becoming a conference (pendingRoom)
//   2. redirect the CALLEE leg into the room. Its departure ends the agent's `<Dial>`
//   3. the agent's Dial `action` fires, sees the pending room, and returns conference
//      TwiML, so the agent follows the callee in instead of hanging up
//   4. originate the third leg, which joins the same room
//
// Step 3 is the whole reason `/api/voice/outbound-dial-complete` exists. Without an action
// URL the agent's call would simply end when the callee was redirected away, which is what
// happens today and is correct today.
//
// The callee hears a few seconds of silence between steps 2 and 3. That is unavoidable in a
// redirect-based escalation and is why the agent is told to say "one moment" first.
//
// STATE IS IN MEMORY ON PURPOSE. It only describes calls that are live right now, and a
// restart drops the calls themselves, so there is nothing to persist. Same reasoning as
// vmDropChildMap, which this sits beside.
import db from './database.js'
import { twilioConfig, toE164, updateCallTwiml, createCall, removeConferenceParticipant } from './twilio.js'
import { vmDropChildMap } from './voice-state.js'

const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))

/** parentSid -> room name, set between "escalate" and the agent's Dial action firing. */
const pendingRoom = new Map()
/** parentSid -> live conference record. */
const conferences = new Map()

export const roomFor = (parentSid) => 'hub-' + String(parentSid || '').slice(-24)
export const pendingRoomFor = (parentSid) => pendingRoom.get(parentSid) || null
export const clearPending = (parentSid) => pendingRoom.delete(parentSid)
export const conferenceFor = (parentSid) => conferences.get(parentSid) || null
const recordingOn = () => { try { return db.getSetting('twilio_record_calls', '1') === '1' } catch { return false } }

/** Forget conferences nothing has touched for two hours, so a long-lived process does
 *  not accumulate rooms whose calls ended without a status callback arriving. */
function sweepStale() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  for (const [k, v] of conferences) if ((v.touchedAt || v.startedAt || 0) < cutoff) conferences.delete(k)
  for (const [k, v] of pendingRoom) if (typeof v === 'object' && (v.at || 0) < cutoff) pendingRoom.delete(k)
}

/**
 * TwiML that puts one leg into the room.
 *
 * endConferenceOnExit is true for the AGENT only: when the person who owns the call hangs
 * up, everyone is released. Otherwise the client and a third party would be left talking to
 * each other on our bill, which is both a cost and a liability.
 *
 * `record` is set only on the first leg in, because the recording starts when the leg that
 * carries it joins; putting it on the agent (who arrives second) would lose the opening.
 * It follows the same twilio_record_calls setting as every other call, so turning recording
 * off still turns it off here.
 */
export function conferenceTwiml({ room, hubBase, isAgent = false, isFirst = false, label = '', record = null }) {
  const rec = (record === null ? recordingOn() : record) && isFirst
    ? ` record="record-from-start" recordingStatusCallback="${esc(hubBase)}/api/voice/conference-recording" recordingStatusCallbackMethod="POST"`
    : ''
  const attrs = [
    'startConferenceOnEnter="true"',
    `endConferenceOnExit="${isAgent ? 'true' : 'false'}"`,
    // A tone when somebody joins or leaves. On a three-way this is not decoration: it is
    // how the client knows a third person is now listening.
    'beep="onEnter"',
    'waitUrl=""',
    label ? `participantLabel="${esc(label)}"` : '',
    `statusCallback="${esc(hubBase)}/api/voice/conference-status"`,
    'statusCallbackMethod="POST"',
    'statusCallbackEvent="start end join leave"',
  ].filter(Boolean).join(' ')
  return `<Dial><Conference ${attrs}${rec}>${esc(room)}</Conference></Dial>`
}

/** The leg currently bridged to the agent, from the child-status webhook. */
function calleeSidFor(parentSid) {
  const hit = vmDropChildMap.get(parentSid)
  return hit?.childSid || null
}

function label(name, number) {
  const n = String(name || '').trim()
  return (n ? n + ' ' : '') + String(number || '')
}

/**
 * Turn a live two-party call into a conference and pull in one more number.
 * Safe to call when the call is ALREADY a conference: it just adds the number.
 */
export async function addToCall({ parentSid, number, name = '', hubBase }) {
  sweepStale()
  if (!parentSid) return { ok: false, error: 'no live call to add to' }
  const to = toE164(number)
  if (!to) return { ok: false, error: 'that does not look like a phone number' }
  const from = twilioConfig().from
  if (!from) return { ok: false, error: 'Twilio is not connected' }

  const existing = conferences.get(parentSid)
  const room = existing?.room || roomFor(parentSid)

  // ---- first escalation: move the two existing legs into the room ----
  if (!existing) {
    const calleeSid = calleeSidFor(parentSid)
    if (!calleeSid) return { ok: false, error: 'the other party is not connected yet - wait until they answer' }
    // Mark BEFORE redirecting: the agent's Dial action can fire the instant the callee
    // leaves, and if the room is not recorded by then the agent is hung up instead.
    pendingRoom.set(parentSid, room)
    conferences.set(parentSid, {
      room, startedAt: Date.now(), touchedAt: Date.now(), agentSid: parentSid,
      legs: new Map([[calleeSid, { number: '', name: '', kind: 'party', joinedAt: null }]]),
      added: [],
    })
    try {
      await updateCallTwiml(calleeSid, conferenceTwiml({ room, hubBase, isFirst: true, label: 'party' }))
    } catch (e) {
      pendingRoom.delete(parentSid); conferences.delete(parentSid)
      return { ok: false, error: 'could not move the call into a conference: ' + e.message }
    }
  }

  // ---- bring in the new number ----
  const url = `${hubBase}/api/voice/conference-join?room=${encodeURIComponent(room)}&label=${encodeURIComponent(label(name, to))}`
  let call
  try {
    call = await createCall({ to, from, url, statusCallback: `${hubBase}/api/voice/conference-status` })
  } catch (e) {
    return { ok: false, error: 'could not dial ' + to + ': ' + e.message, conference_started: true, room }
  }
  const conf = conferences.get(parentSid)
  if (conf) {
    conf.touchedAt = Date.now()
    conf.legs.set(call.sid, { number: to, name, kind: 'added', joinedAt: null })
    conf.added.push({ sid: call.sid, number: to, name, at: Date.now() })
  }
  // Leave a trace on the call's own timeline row, so somebody reading the lead's history
  // later can see a third party was on the call and who it was.
  try {
    const who = String(name || '').trim() || to
    db.run("UPDATE communications SET disposition = ? WHERE external_id = ?",
      [`3-way with ${who}`.slice(0, 120), 'twiliocall_' + parentSid])
  } catch {}
  return { ok: true, room, call_sid: call.sid, to, name: name || '' }
}

/** Hang up one participant and leave the rest talking. */
export async function dropLeg({ parentSid, callSid }) {
  const conf = conferences.get(parentSid)
  if (!conf) return { ok: false, error: 'no conference on this call' }
  if (callSid === conf.agentSid) return { ok: false, error: 'use Hang up to leave the call yourself' }
  try { await removeConferenceParticipant(conf.room, callSid) }
  catch (e) { return { ok: false, error: e.message } }
  conf.touchedAt = Date.now()
  const leg = conf.legs.get(callSid)
  if (leg) leg.left = true
  return { ok: true }
}

/** What the widget renders: who is on this call right now. */
export function stateFor(parentSid) {
  const conf = conferences.get(parentSid)
  if (!conf) return { conference: false, participants: [] }
  const participants = []
  for (const [sid, leg] of conf.legs) {
    if (leg.left) continue
    participants.push({ call_sid: sid, number: leg.number || '', name: leg.name || '', kind: leg.kind, on: !!leg.joinedAt })
  }
  return { conference: true, room: conf.room, started_at: conf.startedAt, participants }
}

/** Twilio conference status callback: keep the live roster honest. */
export function noteConferenceEvent(body = {}) {
  sweepStale()
  const room = String(body.FriendlyName || '')
  const event = String(body.StatusCallbackEvent || '')
  const sid = String(body.CallSid || '')
  for (const [parentSid, conf] of conferences) {
    if (conf.room !== room) continue
    conf.touchedAt = Date.now()
    if (event === 'participant-join' && sid) {
      const leg = conf.legs.get(sid) || { number: '', name: '', kind: sid === parentSid ? 'agent' : 'added' }
      leg.joinedAt = Date.now(); leg.left = false
      conf.legs.set(sid, leg)
    } else if (event === 'participant-leave' && sid) {
      const leg = conf.legs.get(sid)
      if (leg) leg.left = true
    } else if (event === 'conference-end') {
      conferences.delete(parentSid)
      pendingRoom.delete(parentSid)
    }
    return { ok: true, parent_sid: parentSid, event }
  }
  return { ok: false, event, room }
}

/**
 * Conference recording finished. The two-party portion before the escalation already
 * produced its own recording on the original row, so this is a SECOND piece of audio for
 * the same call and cannot simply overwrite it. It is attached where it is not lost: onto
 * the original row if that row has no recording, otherwise onto its own timeline row,
 * labelled, so both halves of the conversation remain playable.
 */
export function attachConferenceRecording(body = {}) {
  const room = String(body.FriendlyName || body.ConferenceSid || '')
  const url = body.RecordingUrl
  if (!url) return { ok: false, error: 'no recording url' }
  let parentSid = null
  for (const [p, conf] of conferences) if (conf.room === room) parentSid = p
  // The conference usually ends (and is forgotten) before its recording is ready, so fall
  // back to the room name, which is derived from the parent SID and survives that.
  const ext = 'twiliocall_' + (parentSid || '')
  const row = parentSid ? db.get('SELECT id, client_id, recording_url, to_addr FROM communications WHERE external_id=?', [ext]) : null
  const dur = Number(body.RecordingDuration || 0) || null
  if (row && !row.recording_url) {
    db.run('UPDATE communications SET recording_url=?, recording_sid=? WHERE id=?', [url, body.RecordingSid || null, row.id])
    return { ok: true, attached_to: row.id, mode: 'original_row' }
  }
  const ins = db.run(`INSERT INTO communications (channel, direction, client_id, to_addr, preview, body, external_id,
             thread_key, status, delivery_status, agent, sent_by_type, recording_url, recording_sid, duration_sec, disposition, occurred_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['call', 'outgoing', row?.client_id || null, row?.to_addr || '', 'Conference call (3-way) recording', '',
      'twiliconf_' + (body.RecordingSid || body.ConferenceSid || Date.now()),
      row?.client_id ? `c${row.client_id}_call` : `conf_${room}`, 'read', 'completed', 'Hub', 'conference',
      url, body.RecordingSid || null, dur, 'Conference (3-way)', new Date().toISOString()])
  return { ok: true, attached_to: ins?.lastInsertRowid || null, mode: 'own_row' }
}

/** Test seam: wipe in-memory state between cases. */
export function _reset() { pendingRoom.clear(); conferences.clear() }
