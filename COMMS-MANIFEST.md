# Hub Communications Manifest — Text, Call & Inbox

**System:** Matt Smith Team Real Estate Hub
**Scope:** Two-way SMS/MMS, browser calling (softphone), unified Inbox, compliance, analytics, security
**Hub number:** **+1 (319) 343‑1562** — A2P 10DLC verified
**Provider:** Twilio (direct REST, no SDK server-side) · SendGrid (email) · Anthropic (AI replies)
**Last updated:** 2026-08-20

---

## 1. Phone number & carrier registration

| Item | Value |
|---|---|
| Hub sending number | **+13193431562** (319‑343‑1562) |
| A2P 10DLC Brand | `BN61005db83796be3c464e6a447b3b9c86` — **APPROVED** |
| A2P Campaign | **VERIFIED**, LOW_VOLUME |
| Messaging Service | `MGea5f65996f2e4a6913761c13dc7fdbd4` |
| SMS | ✅ enabled | 
| MMS (picture texts) | Rides the same US long-code registration; if a picture text fails, check MMS capability in Twilio first |
| Voice | ✅ enabled (browser softphone) |

**Voice infrastructure (auto-provisioned by `server/voice.js`):**
- API Key SID `SKfdc5c0…` + secret → hand-signs the browser access token
- TwiML App `APb615b4…` → routes browser call legs
- Number VoiceUrl wired to the Hub's `/api/voice/outbound`

---

## 2. Where everything lives (file map)

### Backend
| File | Responsibility |
|---|---|
| `server/twilio.js` | SMS/MMS send (`sendSms`, `MediaUrl` support), verify, number wiring, A2P status, comms health check. Direct REST w/ Basic auth. |
| `server/voice.js` | Voice: `ensureVoiceInfra`, `voiceToken` (hand-signed JWT VoiceGrant), `voiceConfigured` |
| `server/twilio-sig.js` | Pure webhook signature validation (`twilioSignatureValid`), `phoneKey10`, `optKeyword` — dependency-free, unit-tested |
| `server/twilio-webhook.js` | `twilioWebhookGuard` middleware (monitor/enforce modes) |
| `server/routes/inbox.js` | Inbox list/threads, send (email+text+MMS), inbound texts, delivery status, bulk text, call notes/dispositions, recording & media proxies, **link preview**, **media upload** |
| `server/index.js` | Voice endpoints (token, outbound, inbound, dial-complete, voicemail, transcription, recording, status), `/uploads` static, comms health/mode routes |
| `server/routes/reporting.js` | `GET /comms` analytics aggregation |
| `server/routes/auth.js` | Whitelists public Twilio webhooks + query-token media/recording proxies |
| `server/routes/email.js` | `fillTemplate` merge-field engine (shared by email + text) |
| `server/database.js` | `communications` table + `hub_text_opt_out` column migrations |

### Frontend
| File | Responsibility |
|---|---|
| `src/pages/Inbox.jsx` | Unified inbox: conversation list, channel-scoped thread, chat bubbles, link previews, inline MMS images, AI reply composer (templates + photo) |
| `src/pages/Clients.jsx` | Lead-profile inline text box (`InlineTextComposer`), bulk text (`BulkTextModal`), Call button → softphone |
| `src/components/CallWidget.jsx` | Browser softphone: registers Device, `window.hubCall()`, accept/reject, mute, DTMF keypad, in-call timer |
| `src/pages/Reporting.jsx` | Separate **Texting** and **Calls** analytics tabs |
| `src/pages/Settings.jsx` | Communications Diagnostics panel + enforce-signature / record-calls toggles |
| `index.html` | Loads `@twilio/voice-sdk@2.18.3` from jsDelivr (deferred, not bundled) |
| `test/comms.test.mjs` | 8 tests (signature valid/tampered/forged/missing, phone match, STOP/START, merge stripping) |

---

## 3. Data model — `communications` table

One unified log for every channel. Key columns:

| Column | Meaning |
|---|---|
| `channel` | `email` \| `text` \| `call` \| `voicemail` |
| `direction` | `incoming` \| `outgoing` |
| `client_id` | Matched Hub client (messages only stored if the sender matches a client) |
| `external_id` | **UNIQUE** — dedup key (`twilio_<sid>`, `sg_<msgid>`, etc.) |
| `thread_key` | One thread per contact+channel (`c<id>_text`) |
| `status` | `unread` \| `read` \| `closed` |
| `delivery_status` | queued / sent / delivered / failed / undelivered / received / missed |
| `duration_sec`, `recording_url`, `recording_sid`, `transcript` | Call/voicemail |
| `disposition`, `notes` | Call outcome + agent notes |
| `media_url` | JSON array of MMS media `[{url,type}]` |
| `error_message` | Friendly carrier error text |
| `agent` | Sending agent |

---

## 4. Texting (SMS / MMS)

### Send paths
1. **Inbox reply** — replies in the thread's channel; text mode hides Subject, adds template picker + insert photo.
2. **Lead profile inline box** — opens under the action buttons; text, template, merge fields, photo, add more recipients.
3. **Bulk text** — select contacts → dedup phones, exclude STOP + no-phone + duplicates → paced background send (~900ms spacing).
4. **New Message composer** — one-off to searched contacts.
5. **Automations `send_text`** — drip/workflow step.

### Merge fields
`fillTemplate(body, client)` fills `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{city}}`, `{{address}}`, `{{agent}}`, `{{price_range}}`, etc. **Unresolved `{{...}}` are stripped** before send so a customer never sees a raw placeholder.

### MMS
- Upload → `POST /api/inbox/upload-media` → stored on the persistent `/data/uploads` disk → served publicly at `/uploads/<file>`.
- Twilio fetches that public URL as `MediaUrl` at send time (up to 10 per message, 5 MB each, images only).
- Incoming MMS images render inline via the authenticated media proxy.

### Link previews
Any URL in a text becomes a clickable link plus an OpenGraph **preview card** (image/title/description/site) via `GET /api/inbox/link-preview` — cached 6h, SSRF-guarded (blocks localhost/private IP ranges).

---

## 5. Calling (browser softphone)

- **Outbound:** Call button anywhere → `window.hubCall(number, name)` → `deviceRef.connect({To})`. Mic is pre-authorized on registration so audio bridges instantly.
- **Inbound:** incoming call panel with **Accept / Reject**.
- **In-call:** mute/unmute, hang-up, live timer, **DTMF keypad** (phone menus/extensions).
- **Missed calls / voicemail:** unanswered → TwiML records a voicemail; missed calls highlighted in the thread.
- **Recording:** optional (Settings toggle `twilio_record_calls`); playback streamed through the authenticated proxy.
- **Dispositions & notes:** per-call outcome (Connected, Left voicemail, No answer, Appointment set, Do not call, …) + free-text notes, logged and reported.
- **Status chip removed** — the softphone stays invisible until a call starts or arrives.

---

## 6. Compliance model (IMPORTANT)

| Flag / Status | Source | Effect |
|---|---|---|
| **`hub_text_opt_out`** | Set when a contact replies **STOP to our Hub number** (cleared by START) | **The ONLY hard block on a 1:1 text** (manual + automation + bulk). Hub-owned, never synced from Sierra. |
| **`donotcontact` / `junk` status** (STOP_STATUSES) | "Do not call" disposition, or a manual status change | **Removes the lead from every active drip + automation** (`stopSequencesForClient`) and **excludes them from bulk + automated texting**. A deliberate 1:1 manual text/call is still allowed. |
| `text_opt_out` (legacy) | Synced/imported from Sierra | **Informational only** — does NOT block texting or calling |
| Calling | — | **Never blocked** by any opt-out |
| "Do not call" disposition | Call outcome | Sets **status = Do Not Contact** → removes all campaigns (see above). Does NOT set the text opt-out or block a 1:1 call. |

Rationale: fresh number + campaign, so old opt-out history doesn't suppress outreach. Honoring STOP-to-our-number is the real CTIA/carrier requirement; everything else is team discretion. **Gate rule:** 1:1 manual text → check `hub_text_opt_out` only; campaign/bulk/automated → also exclude `isStopStatus(status)`.

---

## 7. Inbox

- **Unified:** calls, texts, voicemails, emails grouped into per-contact conversations. Only messages matching a Hub client are stored.
- **Channel filter** scopes both the list AND the open thread (Texts filter → only texts show).
- **Folders:** Inbox / Sent / Closed · All/Unread toggle · search.
- **Gmail-style thread:** latest + unread expanded, older messages collapse.
- **Near-real-time:** list + open thread refresh every 15s.
- **AI Suggested Reply:** reads the thread + client dossier, drafts an on-voice reply; adjust (shorter/casual/direct/warmer), free-text context, regenerate; drafts persist per conversation.
- **Notifications:** inbound text/email alerts to John (and Matt) with detailed subject lines.

---

## 8. Webhook security

- `twilioWebhookGuard` validates the **X-Twilio-Signature** (HMAC-SHA1 of URL + sorted params, base64) on every Twilio POST. URL is rebuilt from `HUB_BASE_URL` so it's correct behind Render's proxy.
- Mode setting `twilio_signature_mode`:
  - `enforce` (**CURRENT** — verified 2026-08-20) — rejects invalid signatures with 403
  - `monitor` — logs mismatches, still accepts (rollout only)
- **Telemetry:** the guard records valid/invalid counts; `GET /api/settings/twilio/signature` reports `ready_to_enforce` and last-invalid details. Verified live: 4 real signed webhooks valid, 0 invalid, before enforcing.
- Public webhook routes are whitelisted in `auth.js`; media/recording proxies accept a query `?token=` (validated identically to the header).

## 8b. Unknown-inbound queue

- An inbound **text OR call from a number not in the CRM** is captured (not dropped): stored with `client_id NULL` and `thread_key = u_<phone10>`, shown in the inbox with an **Unknown** badge. John gets an email alert for unknown texters.
- Open one → **Create lead** (one click) or **Link to existing** (search). This re-points the whole thread onto the client (`relinkUnknownThread`); it then behaves as a normal conversation and future messages auto-match.
- Endpoints: `GET /unknown-thread?key=`, `POST /unknown-thread/read`, `POST /unknown/create-lead`, `POST /unknown/link`.

## 8c. Missed-call auto text-back

- When an inbound call goes unanswered, HUB texts the caller (e.g. "Sorry we missed your call!..."). Setting `missed_call_textback_enabled` (default on) + `missed_call_textback_message` (editable in Settings).
- Uses the same permission model: known contacts who replied STOP or are Do Not Contact/Junk are skipped; unknown callers are allowed (they just called us). Deduped per call (`missedcb_<CallSid>`).

## 8d. Scheduled one-to-one texting

- Table `scheduled_texts`; a scheduler tick (every 60s) sends due texts after a **fresh compliance re-check at send time** (STOP / Do Not Contact / no-phone → canceled, not sent).
- Endpoints: `POST /schedule-text`, `GET /scheduled?client_id=`, `POST /scheduled/:id/cancel`.
- UI: lead-profile inline composer has a **🕑 Schedule** button (datetime) + a pending-scheduled list with cancel; the Inbox text reply has a Schedule option. Sends land in the normal thread.

---

## 9. API endpoints

### Inbox / texting (`/api/inbox`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Conversation list (folder, unread, channels, q) |
| GET | `/thread/:clientId` | Full thread |
| POST | `/send` | Send email **or** text/MMS (`channel`, `client_ids[]`, `body`, `subject?`, `media[]?`) |
| POST | `/bulk-text` | Bulk SMS campaign (paced background send) |
| GET | `/contacts` | Contact search for composer |
| POST | `/upload-media` | Upload a photo for MMS → public URL |
| GET | `/media/:id/:idx` | MMS image proxy (auth) |
| GET | `/link-preview` | OpenGraph card for a URL |
| GET | `/recording/:id` | Call/voicemail audio proxy (auth) |
| POST | `/:id/annotate` | Call notes + disposition |
| POST | `/thread/:clientId/read` · `/close` | Thread state |
| POST | `/thread/:clientId/ai/suggest` · `/ai/adjust` · `/draft` | AI reply |
| POST | `/twilio-inbound` | **Public** — incoming texts (STOP/START + MMS capture) |
| POST | `/twilio-status` | **Public** — delivery status reconcile |
| POST | `/parse-inbound` | **Public** — SendGrid inbound email |

### Voice (`/api/voice`)
`token` · `setup` · `outbound` · `inbound` · `dial-complete` · `voicemail-done` · `transcription` · `recording` · `status`
(all except `token`/`setup` are public, signature-validated Twilio webhooks)

### Settings / analytics
`GET /api/settings/twilio/health` · `POST /api/settings/twilio/mode` · `/a2p` · `/test-send` · `/wire-number` · `GET /api/reporting/comms`

---

## 10. Settings keys (`app_settings`)

| Key | Purpose |
|---|---|
| `twilio_account_sid`, `twilio_auth_token` | Account creds |
| `twilio_from_number` | Hub sending number |
| `twilio_messaging_service_sid` | A2P messaging service |
| `twilio_enabled` | Master on/off |
| `twilio_api_key_sid`, `twilio_api_key_secret` | Voice token signing |
| `twilio_twiml_app_sid` | Voice routing app |
| `twilio_record_calls` | Call recording toggle |
| `twilio_signature_mode` | `monitor` \| `enforce` |
| `inbox_notify_email` | Where inbound alerts go |

---

## 11. Analytics (Reporting → Texting / Calls tabs)

- **Texting:** sent, received, delivery rate, failed, reply rate, texts-by-day chart.
- **Calls:** placed, received, answered, missed, voicemails, avg length, calls-by-day chart, disposition breakdown.
- Sourced instantly from the `communications` log (no Twilio API calls).

---

## 12. Operational notes

- **Deploy:** `git push origin HEAD` → Render auto-deploy (~2‑3 min, brief 502 during swap). Verify: health `200` + new `index-*.js` bundle hash.
- **Persistence:** SQLite + uploads live on Render's `/data` disk (`DB_DIR`).
- **Tests:** `npm test` (node:test, 11 tests). **Build:** `npm run build`.
- **Diagnostics:** Settings → Communications Diagnostics (live health of account, number capabilities, webhooks, A2P, calling, signature mode, recording).
- **Softphone SDK:** loaded from jsDelivr CDN (Twilio's own CDN 403s for 2.x) — deferred `<script>`, not bundled.
- **Rate limits:** Twilio 429s on ~100 rapid calls; bulk sends are spaced ~900ms with per-recipient error capture.

---

## 13. CRM-workflow layer (roadmap items 5–11, added 2026-08-20)

- **#5 Conversation ownership** — each conversation has an assigned agent (`clients.agent_assigned`). Inbox sidebar: All / Mine / Unassigned + an "I am" agent picker (localStorage). Assignee chips on rows, reassign dropdown in the thread header. `GET /inbox/agents` (setting `inbox_agents`, default Matt,John,Hunter), `POST /thread/:id/assign`. Assigning emits a `contact_assigned` automation event.
- **#7 Call routing + business hours** — outside configured hours, inbound calls skip the browser and go straight to an after-hours greeting + voicemail. Optional forward-to-mobile on a missed call (falls through to voicemail). Settings panel "Call Routing & Business Hours" with a live Open/Closed indicator. `GET/POST /api/settings/voice`. Logic in the pure, tested `businessOpen()`.
- **#8 Automation comm-triggers** — the builder now fires on: **Incoming Text**, **Text Replied**, **Missed Call**, **Voicemail Received**, **Call Outcome Set** (per-disposition filter). Events emitted at each comm point via the existing `automation_events` bus → enroll into any active automation.
- **#9 Bulk campaign management** — `text_campaigns` table + `campaign_id` on communications. Each blast is an auditable record (name, created_by, recipient math, status). Double-launch guard (identical name/body within 120s → 409). `GET /inbox/campaigns` with live counts (sent, delivered, failed, replies, opt-outs); shown in Reporting → Texting. Campaign-name field in the bulk composer.
- **#10 Test coverage** — 11 tests (added business-hours boundaries + bulk exclusion), pure logic extracted to `server/comms-logic.js`.
- **#11 Real-time inbox** — `GET /api/inbox/stream` (Server-Sent Events) pushes a `changed` event on any new communication; the inbox updates near-instantly. 45s poll kept as a backstop.

**Still open (from the external review):** #12 power dialer. Ring-group / simultaneous-team ring is deferred (needs per-agent Twilio identities; the current model uses a single `hub` browser identity).
