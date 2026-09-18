// PUBLIC BOOKING (no auth — mounted BEFORE requireAuth, like the webhooks).
// Serves the mobile-first booking page at /book/{slug} + the manage page at
// /appointment/manage/{token}, and the JSON endpoints they call. Public
// responses never expose internal client ids or CRM data; manage links are
// crypto-random tokens. Simple per-IP rate limiting on all public endpoints.
import express from 'express'
import db from '../database.js'
import {
  initScheduling, getType, availableDays, slotsForDate, findOrCreateLead,
  bookAppointment, sendBookingConfirmations, getByToken, rescheduleAppointment,
  cancelAppointment, fmtCtPretty, buildIcs, trackBookingEvent,
} from '../scheduling.js'

const router = express.Router()

// ---- rate limiting (in-memory sliding bucket per IP) ----
const buckets = new Map()
function rateLimit(limit = 60, windowMs = 60000) {
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown'
    const now = Date.now()
    let b = buckets.get(ip)
    if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(ip, b) }
    if (++b.n > limit) return res.status(429).json({ error: 'Too many requests — please slow down.' })
    if (buckets.size > 5000) buckets.clear()
    next()
  }
}

const publicType = (t) => ({
  slug: t.slug, public_title: t.public_title, description: t.description,
  duration_min: t.duration_min, location_type: t.location_type,
  require_address: !!t.require_address, questions: (() => { try { return JSON.parse(t.questions_json || '[]') } catch { return [] } })(),
  confirmation_message: t.confirmation_message,
})

const activeType = (slug) => {
  initScheduling()
  const t = getType(slug)
  return t && t.active ? t : null
}

// ---- JSON API ----
router.get('/api/public/booking/:slug', rateLimit(120), (req, res) => {
  const t = activeType(req.params.slug)
  if (!t) return res.status(404).json({ error: 'Booking page not found' })
  res.json(publicType(t))
})

router.get('/api/public/booking/:slug/days', rateLimit(120), (req, res) => {
  const t = activeType(req.params.slug)
  if (!t) return res.status(404).json({ error: 'not found' })
  res.json({ days: availableDays(t) })
})

router.get('/api/public/booking/:slug/slots', rateLimit(120), (req, res) => {
  const t = activeType(req.params.slug)
  if (!t) return res.status(404).json({ error: 'not found' })
  const date = String(req.query.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' })
  res.json({ date, slots: slotsForDate(t, date).map(s => s.time) })
})

router.post('/api/public/booking/:slug/track', rateLimit(240), (req, res) => {
  trackBookingEvent(req.params.slug, req.body?.event, req.body?.session, req.body?.meta)
  res.json({ ok: true })
})

router.post('/api/public/booking/:slug/book', rateLimit(15, 60000), async (req, res) => {
  try {
    const t = activeType(req.params.slug)
    if (!t) return res.status(404).json({ error: 'Booking page not found' })
    const b = req.body || {}
    const date = String(b.date || ''), time = String(b.time || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Please pick a date and time.' })
    const first = String(b.first_name || '').trim().slice(0, 60)
    const last = String(b.last_name || '').trim().slice(0, 60)
    const phone = String(b.phone || '').trim().slice(0, 30)
    const email = String(b.email || '').trim().slice(0, 120)
    if (!first || !phone) return res.status(400).json({ error: 'Name and mobile phone are required.' })
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' })
    const address = String(b.address || '').trim().slice(0, 160)
    const city = String(b.city || '').trim().slice(0, 60)
    const state = String(b.state || 'IA').trim().slice(0, 20)
    const zip = String(b.zip || '').trim().slice(0, 12)
    if (t.require_address && !address) return res.status(400).json({ error: 'Property address is required.' })
    // Attribution: URL params passed through by the page.
    const attr = {}
    for (const k of ['lead_id', 'client_id', 'source', 'campaign', 'adset', 'ad', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
      if (b.attr && b.attr[k] != null) attr[k] = String(b.attr[k]).slice(0, 120)
    }
    const leadId = Number(attr.lead_id || attr.client_id) || null
    const { client_id, matched } = findOrCreateLead({
      lead_id: leadId, first, last, phone, email, address: address || null, city: city || null, state, zip: zip || null,
      source: attr.utm_source || attr.source || t.name,
    })
    // Keep contact info fresh on matched leads without overwriting existing values.
    try {
      db.run(`UPDATE clients SET email = COALESCE(NULLIF(email,''), ?), address = COALESCE(NULLIF(address,''), ?), city = COALESCE(NULLIF(city,''), ?), zip = COALESCE(NULLIF(zip,''), ?), updated_at = ? WHERE id = ?`,
        [email || null, address || null, city || null, zip || null, new Date().toISOString(), client_id])
    } catch {}
    const answers = {}
    try { for (const q of JSON.parse(t.questions_json || '[]')) { if (b.answers && b.answers[q.key] != null) answers[q.key] = String(b.answers[q.key]).slice(0, 500) } } catch {}
    const propertyAddress = [address, city].filter(Boolean).join(', ') || null
    const r = bookAppointment({
      type: t, dateStr: date, time, client_id, propertyAddress,
      answers: Object.keys(answers).length ? answers : null,
      attribution: Object.keys(attr).length ? attr : null,
      source: attr.utm_source || attr.source || 'Meta', campaign: attr.utm_campaign || attr.campaign || null,
      createdBy: 'public', notes: answers.notes || null,
    })
    trackBookingEvent(t.slug, 'booking_completed', b.session, { matched })
    sendBookingConfirmations(r.id).catch(e => console.error('[booking] confirmations:', e.message))
    res.json({
      ok: true, manage_token: r.token,
      when: fmtCtPretty(date, time), date, time,
      property: propertyAddress, type: t.name, team_member: r.member,
      message: t.confirmation_message || "We'll send you a confirmation shortly.",
    })
  } catch (e) {
    if (e.code === 'SLOT_TAKEN') return res.status(409).json({ error: e.message })
    console.error('[booking] book error:', e.message)
    res.status(500).json({ error: 'Something went wrong — please try again.' })
  }
})

// ---- public manage (secure token) ----
const publicAppt = (e) => {
  const type = e.appt_type_id ? db.get('SELECT name, public_title, slug, duration_min FROM appointment_types WHERE id = ?', [e.appt_type_id]) : null
  return {
    when: fmtCtPretty(e.event_date, e.start_time), date: e.event_date, time: e.start_time,
    property: e.location || null, type: type?.name || e.event_type, slug: type?.slug || null,
    team_member: e.team_member || null, status: e.appt_status,
  }
}

router.get('/api/public/appointment/:token', rateLimit(60), (req, res) => {
  const e = getByToken(req.params.token)
  if (!e) return res.status(404).json({ error: 'Appointment not found' })
  res.json(publicAppt(e))
})

router.post('/api/public/appointment/:token/reschedule', rateLimit(10), (req, res) => {
  try {
    const e = getByToken(req.params.token)
    if (!e) return res.status(404).json({ error: 'Appointment not found' })
    if (!['scheduled', 'confirmed'].includes(e.appt_status)) return res.status(400).json({ error: 'This appointment can no longer be changed.' })
    const date = String(req.body?.date || ''), time = String(req.body?.time || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'invalid date/time' })
    rescheduleAppointment(e.id, date, time, { by: 'client' })
    const fresh = getByToken(req.params.token)
    sendBookingConfirmations(e.id).catch(() => {})
    res.json({ ok: true, ...publicAppt(fresh) })
  } catch (err) {
    if (err.code === 'SLOT_TAKEN') return res.status(409).json({ error: err.message })
    res.status(500).json({ error: 'Could not reschedule — please try again.' })
  }
})

router.post('/api/public/appointment/:token/cancel', rateLimit(10), (req, res) => {
  const e = getByToken(req.params.token)
  if (!e) return res.status(404).json({ error: 'Appointment not found' })
  if (e.appt_status === 'cancelled') return res.json({ ok: true, status: 'cancelled' })
  cancelAppointment(e.id, { by: 'client', reason: String(req.body?.reason || '').slice(0, 300) })
  res.json({ ok: true, status: 'cancelled' })
})

router.get('/api/public/appointment/:token/ics', rateLimit(30), (req, res) => {
  const e = getByToken(req.params.token)
  if (!e) return res.status(404).send('Not found')
  const ics = buildIcs({ id: e.id, title: e.title, dateStr: e.event_date, time: e.start_time, endTime: e.end_time, location: e.location, description: 'Matt Smith Team appointment', attendees: [] })
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"')
  res.send(ics)
})

// ---- Calendbook webhooks (shared-key, one URL per event kind) ----
router.post('/api/public/calendbook/:kind', rateLimit(60), async (req, res) => {
  try {
    const { calendbookKey, handleCalendbookWebhook } = await import('../calendbook.js')
    if (String(req.query.key || '') !== calendbookKey()) return res.status(403).json({ error: 'bad key' })
    const kind = String(req.params.kind || '').toLowerCase()
    if (!['booking', 'reschedule', 'cancellation', 'reminder'].includes(kind)) return res.status(400).json({ error: 'unknown kind' })
    res.json(await handleCalendbookWebhook(kind, req.body || {}))
  } catch (e) { console.error('[calendbook]', e.message); res.status(500).json({ error: 'intake error' }) }
})

// ---- HTML pages ----
router.get('/book/:slug', rateLimit(60), (req, res, next) => {
  const t = activeType(req.params.slug)
  if (!t) return next()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(bookingHtml(t))
})
router.get('/appointment/manage/:token', rateLimit(60), (req, res, next) => {
  const e = getByToken(req.params.token)
  if (!e) return next()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(bookingHtml(null, { manageToken: req.params.token }))
})
// Bare /{slug} vanity path -> /book/{slug} (only for real active types, so SPA routes are untouched).
router.get('/:slug', (req, res, next) => {
  const t = /^[a-z0-9-]{3,60}$/.test(req.params.slug) ? activeType(req.params.slug) : null
  if (!t) return next()
  res.redirect(302, `/book/${t.slug}`)
})

// ---------------------------------------------------------------------------
// The page: one server-rendered file, no SPA payload, mobile-first, Hub-branded.
// ---------------------------------------------------------------------------
function bookingHtml(type, { manageToken = null } = {}) {
  const cfg = JSON.stringify(type ? { mode: 'book', slug: type.slug, ...{
    title: type.public_title, description: type.description, duration: type.duration_min,
    require_address: !!type.require_address, questions: (() => { try { return JSON.parse(type.questions_json || '[]') } catch { return [] } })(),
  } } : { mode: 'manage', token: manageToken })
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&display=swap" rel="stylesheet">
<title>${type ? String(type.public_title || 'Book an appointment').replace(/</g, '&lt;') : 'Manage your appointment'} — Matt Smith Team</title>
<style>
/* Matt Smith Team editorial system — mirrors mattsmithteam.com:
   Cormorant Garamond display, ink #1a1a1a, gold #d4af37/#b08930, paper #f5f3ef. */
:root{--ink:#1a1a1a;--ink-soft:#3a3a3a;--gold:#d4af37;--gold-deep:#b08930;--paper:#f5f3ef;--card:#ffffff;--muted:#77716a;--line:#e6e1d8}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--paper);color:var(--ink);font-family:Arial,Roboto,sans-serif;overscroll-behavior:none}
.serif{font-family:'Cormorant Garamond',Georgia,serif}
.wrap{max-width:600px;margin:0 auto;padding:0 16px 56px}
.brand{text-align:center;padding:26px 0 20px}
.brand .wordmark{font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.brand .rule{width:44px;height:2px;background:var(--gold);margin:9px auto 7px}
.brand .sub{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:30px 22px 26px;box-shadow:0 10px 34px rgba(26,26,26,.07)}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:30px;line-height:1.18;margin:0 0 10px;text-wrap:balance}
p.lead{margin:0;color:var(--ink-soft);font-size:15px;line-height:1.65}
.step-label{font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-deep);margin:0 0 10px}
button{font-family:inherit}
.btn{display:block;width:100%;padding:16px;border:none;background:var(--ink);color:var(--gold);font-weight:700;font-size:13.5px;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;touch-action:manipulation;border-radius:3px}
.btn:active{opacity:.85}
.btn[disabled]{opacity:.45}
.btn-ghost{background:none;border:1px solid var(--ink);color:var(--ink)}
.grid{display:grid;gap:9px;margin:14px 0}
.times{grid-template-columns:repeat(auto-fill,minmax(106px,1fr))}
.slot{padding:13px 6px;border:1px solid var(--line);border-radius:3px;background:#fff;font-size:15px;font-weight:600;cursor:pointer;text-align:center;min-height:48px;color:var(--ink)}
.slot.sel,.slot:active{border-color:var(--gold-deep);background:#faf5e7}
.cal-head{display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px}
.cal-head strong{font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:600;letter-spacing:.02em}
.cal-nav{width:40px;height:40px;border:1px solid var(--line);border-radius:3px;background:#fff;font-size:20px;cursor:pointer;color:var(--ink)}
.cal-nav[disabled]{opacity:.25}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.cal-wd{text-align:center;font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--muted);padding:5px 0}
.cal-day{display:flex;align-items:center;justify-content:center;aspect-ratio:1;border-radius:3px;font-size:15px;font-weight:600;min-height:42px}
.cal-day.off{color:var(--muted);opacity:.35}
.cal-day.open{border:1px solid var(--gold-deep);background:#fbf7ea;color:var(--ink);cursor:pointer}
.cal-day.open:active{background:var(--gold);color:var(--ink)}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);margin:14px 0 6px}
input,select,textarea{width:100%;padding:13px 12px;border:1px solid var(--line);border-radius:3px;font-size:16px;font-family:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--gold-deep)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.summary{background:#fbf7ea;border:1px solid #eadfbe;border-radius:3px;padding:16px;margin:14px 0;font-size:14.5px;line-height:1.65}
.summary strong{font-family:'Cormorant Garamond',Georgia,serif;font-size:19px;font-weight:600}
.err{background:#fdf1f0;border:1px solid #eec7c3;color:#a03a30;border-radius:3px;padding:11px 13px;font-size:13.5px;margin:10px 0;display:none}
.back{background:none;border:none;color:var(--muted);font-size:13px;letter-spacing:.06em;cursor:pointer;padding:10px 0;margin-top:8px}
.done-icon{width:58px;height:58px;border-radius:50%;border:1.5px solid var(--gold-deep);color:var(--gold-deep);display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 14px;background:#fbf7ea}
.actions{display:grid;gap:10px;margin-top:18px}
.muted{color:var(--muted);font-size:12.5px}
.spin{text-align:center;color:var(--muted);padding:26px 0;font-size:14px}
.foot{text-align:center;margin-top:20px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
</style></head>
<body><div class="wrap">
<div class="brand"><div class="wordmark">Matt Smith Team</div><div class="rule"></div><div class="sub">RE/MAX Concepts &middot; Cedar Rapids, Iowa</div></div>
<div class="card" id="app"><div class="spin">Loading&hellip;</div></div>
<p class="foot">mattsmithteam.com</p>
</div>
<script>
var CFG=${cfg};
var S={step:0,days:[],date:null,slots:[],time:null,appt:null,session:Math.random().toString(36).slice(2)+Date.now().toString(36)};
var qs=new URLSearchParams(location.search);
var ATTR={};['lead_id','client_id','source','campaign','adset','ad','utm_source','utm_medium','utm_campaign','utm_content'].forEach(function(k){if(qs.get(k))ATTR[k]=qs.get(k)});
function api(p,opts){return fetch(p,Object.assign({headers:{'Content-Type':'application/json'}},opts)).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong');return j})})}
function track(ev,meta){if(CFG.mode!=='book')return;fetch('/api/public/booking/'+CFG.slug+'/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:ev,session:S.session,meta:meta||null})}).catch(function(){})}
function el(h){var d=document.getElementById('app');d.innerHTML=h;window.scrollTo(0,0)}
function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]})}
function dayLabel(d){var dt=new Date(d+'T12:00:00');return{top:dt.toLocaleDateString('en-US',{weekday:'short'}),n:dt.getDate(),m:dt.toLocaleDateString('en-US',{month:'short'})}}
function t12(t){var p=t.split(':');var h=+p[0];var ap=h>=12?'PM':'AM';h=h%12||12;return h+':'+p[1]+' '+ap}
function whenPretty(d,t){return new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+' at '+t12(t)}
function showErr(m){var e=document.getElementById('err');if(e){e.textContent=m;e.style.display='block'}}

// The page opens straight on a FULL MONTH CALENDAR (John, 2026-09-18): headline +
// one-line pitch, then the current month with available dates tappable and
// everything else greyed out. Month arrows walk to the next months inside the
// booking horizon. Pick a date -> pick a time -> contact details.
function introHtml(){return '<div class="step-label">Complimentary Pre-Listing Walkthrough</div><h1>'+esc(CFG.title)+'</h1><p class="lead">'+esc(CFG.description)+'</p>'}
function monthOf(d){return d.slice(0,7)}
function stepDays(){el(introHtml()+'<div class="spin">Finding open times&hellip;</div>');
api('/api/public/booking/'+CFG.slug+'/days').then(function(j){S.days=j.days||[];
if(!S.days.length)return el(introHtml()+'<p class="lead" style="margin-top:14px"><strong>No times open right now.</strong> Please check back soon, or call/text us at (319) 343-1562 and we&rsquo;ll find a time.</p>');
S.months=[];S.days.forEach(function(d){var mo=monthOf(d);if(S.months.indexOf(mo)<0)S.months.push(mo)});
var cur=monthOf(new Date().toISOString());if(S.months.indexOf(cur)<0)S.months.unshift(cur);
S.months.sort();if(S.mi==null||S.mi>=S.months.length)S.mi=0;
renderMonth()})}
function renderMonth(){var mo=S.months[S.mi];var y=+mo.slice(0,4),mn=+mo.slice(5,7);
var first=new Date(y,mn-1,1),dim=new Date(y,mn,0).getDate(),lead=first.getDay();
var name=first.toLocaleDateString('en-US',{month:'long',year:'numeric'});
var open={};S.days.forEach(function(d){if(monthOf(d)===mo)open[+d.slice(8,10)]=d});
var h=introHtml();
h+='<div class="cal-head"><button class="cal-nav" id="pm" '+(S.mi<=0?'disabled':'')+'>&lsaquo;</button><strong>'+name+'</strong><button class="cal-nav" id="nm" '+(S.mi>=S.months.length-1?'disabled':'')+'>&rsaquo;</button></div>';
h+='<div class="cal-grid">';
['S','M','T','W','T','F','S'].forEach(function(w){h+='<div class="cal-wd">'+w+'</div>'});
for(var i=0;i<lead;i++)h+='<div></div>';
for(var day=1;day<=dim;day++){
if(open[day])h+='<button class="cal-day open" data-d="'+open[day]+'">'+day+'</button>';
else h+='<div class="cal-day off">'+day+'</div>'}
h+='</div><p class="muted" style="text-align:center;margin-top:10px">Tap an available date &middot; All times Central</p>';
el(h);
var pm=document.getElementById('pm'),nm=document.getElementById('nm');
if(pm)pm.onclick=function(){if(S.mi>0){S.mi--;renderMonth()}};
if(nm)nm.onclick=function(){if(S.mi<S.months.length-1){S.mi++;renderMonth()}};
Array.prototype.forEach.call(document.querySelectorAll('.cal-day.open'),function(b){b.onclick=function(){if(!S.started){S.started=1;track('booking_started')}S.date=b.dataset.d;track('date_selected',{date:S.date});stepTimes()}})}

function stepTimes(){el('<div class="step-label">Step 2 of 3</div><h1>'+whenPretty(S.date,'12:00').split(' at ')[0]+'</h1><div class="spin">Loading times&hellip;</div>');
api('/api/public/booking/'+CFG.slug+'/slots?date='+S.date).then(function(j){S.slots=j.slots||[];
if(!S.slots.length){stepDays();return}
var h='<div class="step-label">Step 2 of 3</div><h1>Available times</h1><p class="lead">'+whenPretty(S.date,'12:00').split(' at ')[0]+' &middot; All times Central</p><div class="grid times">';
S.slots.forEach(function(t){h+='<button class="slot" data-t="'+t+'">'+t12(t)+'</button>'});
h+='</div><button class="back" id="back">&larr; Different day</button>';el(h);
document.getElementById('back').onclick=stepDays;
Array.prototype.forEach.call(document.querySelectorAll('.slot[data-t]'),function(b){b.onclick=function(){S.time=b.dataset.t;track('time_selected',{date:S.date,time:S.time});stepForm()}})})}

function stepForm(){var qh='';(CFG.questions||[]).forEach(function(q){
if(q.type==='choice'){qh+='<label>'+esc(q.label)+' <span class="muted">(optional)</span></label><select id="q_'+q.key+'"><option value="">Select&hellip;</option>'+q.options.map(function(o){return'<option>'+esc(o)+'</option>'}).join('')+'</select>'}
else{qh+='<label>'+esc(q.label)+' <span class="muted">(optional)</span></label><textarea id="q_'+q.key+'" rows="2"></textarea>'}});
el('<div class="step-label">Step 3 of 3</div><h1>Almost done</h1>'+
'<div class="summary"><strong>'+(CFG.title||'Your appointment')+'</strong><br>'+whenPretty(S.date,S.time)+'<br>'+CFG.duration+' minutes</div>'+
'<div class="row2"><div><label>First name</label><input id="f_first" autocomplete="given-name" required></div><div><label>Last name</label><input id="f_last" autocomplete="family-name"></div></div>'+
'<label>Mobile phone</label><input id="f_phone" type="tel" autocomplete="tel" inputmode="tel" required>'+
'<label>Email</label><input id="f_email" type="email" autocomplete="email" inputmode="email">'+
(CFG.require_address?'<label>Property address</label><input id="f_address" autocomplete="street-address" required><div class="row2"><div><label>City</label><input id="f_city" value=""></div><div><label>ZIP</label><input id="f_zip" inputmode="numeric"></div></div>':'')+
qh+'<div class="err" id="err"></div><div style="margin-top:16px"><button class="btn" id="submit">Book My Time</button></div><button class="back" id="back">&larr; Different time</button>');
track('form_started');
document.getElementById('back').onclick=stepTimes;
document.getElementById('submit').onclick=function(){
var g=function(id){var e=document.getElementById(id);return e?e.value.trim():''};
var answers={};(CFG.questions||[]).forEach(function(q){var v=g('q_'+q.key);if(v)answers[q.key]=v});
var btn=this;btn.disabled=true;btn.textContent='Booking\\u2026';
api('/api/public/booking/'+CFG.slug+'/book',{method:'POST',body:JSON.stringify({date:S.date,time:S.time,first_name:g('f_first'),last_name:g('f_last'),phone:g('f_phone'),email:g('f_email'),address:g('f_address'),city:g('f_city'),zip:g('f_zip'),answers:answers,attr:ATTR,session:S.session})})
.then(function(j){S.appt=j;stepDone()})
.catch(function(e){btn.disabled=false;btn.textContent='Book My Time';showErr(e.message);if(/just taken/i.test(e.message))setTimeout(stepTimes,1600)})}}

function stepDone(){var a=S.appt;
el('<div class="done-icon">\\u2713</div><h1 style="text-align:center">You\\u2019re booked!</h1>'+
'<div class="summary"><strong>'+esc(a.type)+'</strong><br>'+esc(a.when)+(a.property?'<br>'+esc(a.property):'')+(a.team_member?'<br>With '+esc(a.team_member):'')+'</div>'+
'<p class="lead">'+esc(a.message)+'</p>'+
'<div class="actions">'+
'<a class="btn" style="text-align:center;text-decoration:none" href="/api/public/appointment/'+a.manage_token+'/ics">Add to Calendar</a>'+
'<a class="btn btn-ghost" style="text-align:center;text-decoration:none" href="/appointment/manage/'+a.manage_token+'">Reschedule or Cancel</a>'+
'</div>')}

// ---- manage mode ----
function manage(){api('/api/public/appointment/'+CFG.token).then(function(a){
if(a.status==='cancelled')return el('<h1>Appointment cancelled</h1><p class="lead">This appointment was cancelled. If you\\u2019d like to rebook, we\\u2019d love to see you \\u2014 call or text (319) 343-1562.</p>');
el('<div class="step-label">Your appointment</div><h1>'+esc(a.type)+'</h1>'+
'<div class="summary"><strong>'+esc(a.when)+'</strong>'+(a.property?'<br>'+esc(a.property):'')+(a.team_member?'<br>With '+esc(a.team_member):'')+'</div>'+
'<div class="actions">'+
'<a class="btn btn-ghost" style="text-align:center;text-decoration:none" href="/api/public/appointment/'+CFG.token+'/ics">Add to Calendar</a>'+
(a.slug?'<button class="btn" id="resch">Reschedule</button>':'')+
'<button class="btn btn-ghost" id="cancel" style="color:#b91c1c;border-color:#fecaca">Cancel Appointment</button></div><div class="err" id="err"></div>');
if(a.slug){CFG.slug=a.slug;document.getElementById('resch').onclick=function(){S.resch=true;stepDays();};}
document.getElementById('cancel').onclick=function(){
if(!confirm('Cancel this appointment?'))return;
api('/api/public/appointment/'+CFG.token+'/cancel',{method:'POST',body:JSON.stringify({})}).then(function(){el('<h1>Appointment cancelled</h1><p class="lead">You\\u2019re all set \\u2014 the appointment has been cancelled. If plans change, we\\u2019re happy to find another time.</p>')}).catch(function(e){showErr(e.message)})}}).catch(function(){el('<h1>Link not found</h1><p class="lead">This appointment link isn\\u2019t valid anymore.</p>')})}

// Reschedule reuses the day/time steps then confirms against the manage endpoint.
var origStepForm=stepForm;
stepForm=function(){if(!S.resch)return origStepForm();
api('/api/public/appointment/'+CFG.token+'/reschedule',{method:'POST',body:JSON.stringify({date:S.date,time:S.time})})
.then(function(j){el('<div class="done-icon">\\u2713</div><h1 style="text-align:center">Rescheduled!</h1><div class="summary"><strong>'+esc(j.type)+'</strong><br>'+esc(j.when)+(j.property?'<br>'+esc(j.property):'')+'</div><p class="lead">We\\u2019ve updated everything \\u2014 you\\u2019ll get a fresh confirmation.</p><div class="actions"><a class="btn" style="text-align:center;text-decoration:none" href="/api/public/appointment/'+CFG.token+'/ics">Add to Calendar</a></div>')})
.catch(function(e){showErr(e.message);setTimeout(stepTimes,1500)})}

if(CFG.mode==='book'){track('page_view');stepDays()}else{manage()}
</script></body></html>`
}

export default router
