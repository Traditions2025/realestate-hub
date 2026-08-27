# Matt Smith Team — Hub System Overview

**Real Estate Command Center** for the Matt Smith Team (RE/MAX Real Estate Concepts, Cedar Rapids / Marion, Iowa).
This is the single source of truth for how the Hub is built, what it does, the tools it depends on, and every moving part.

- **Live app:** https://realestate-hub-1rzu.onrender.com
- **Repo:** github.com/Traditions2025/realestate-hub
- **Version:** 2.0.0
- **Last documented:** 2026-08-21

---

## 1. What the Hub Is

A self-hosted CRM + operations platform that sits on top of the team's existing lead sources (Sierra Interactive, Follow Up Boss) and communication rails (Twilio, SendGrid, Gmail). It is **the master system of record** for transactions and the team's daily workflow. It replaces a patchwork of spreadsheets, Zapier flows, and manual copy-paste with one installable web app.

Core idea: leads and web activity flow IN from Sierra and FUB; the team works them inside the Hub (texting, calling, email, tasks, transactions, AI follow-up); status and tags flow BACK OUT to Sierra.

**Key principle:** The Hub DB is master. Transactions are never synced from the Google Sheet. Sierra is read-mostly (we pull leads in; we push only status + tags back).

---

## 2. Tech Stack & Tools

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite (JSX), React Router 6 |
| Backend | Node.js + Express 4 (ESM modules) |
| Database | better-sqlite3 (single-file SQLite, ~40 MB) |
| AI | Anthropic Claude (`@anthropic-ai/sdk`), model via `ANTHROPIC_MODEL` (Claude Sonnet) |
| Texting / Calling | Twilio (direct REST, Basic auth) |
| Email (outbound) | SendGrid |
| Email (inbound) | Gmail IMAP (`imapflow` + `mailparser`) and/or SendGrid Inbound Parse |
| Uploads | `busboy` (multipart) |
| Mobile | PWA (installable) + Capacitor scaffolding for native shells |
| Hosting | Render (auto-deploy on `git push`) |
| Automation glue | n8n (social publishing), legacy Zapier |

**External data sources / APIs the Hub talks to:**
- **Sierra Interactive API** — lead pull + status/tag write-back (lead-only API).
- **Follow Up Boss API** — web activity, property views, custom fields (Realist Sell Score, budget ranges), templates. FUB is used where Sierra doesn't share data (e.g. web-activity history).
- **Twilio** — SMS/MMS, voice calls, voicemail, browser softphone.
- **SendGrid** — outbound email + engagement stats (opens/clicks) + inbound parse.
- **Google Calendar** — iCal feed sync (read-only).
- **Slack** — deadline alerts + ops notifications (incoming webhook).
- **Anthropic Claude** — AI ISA follow-up, listing descriptions, transaction parsing, suggested follow-ups.

---

## 3. Hosting & Deployment

- **Host:** Render web service. `npm start` → `node server/index.js`. Express serves both the API and the built React bundle from `dist/`.
- **Deploy:** `git push origin HEAD` triggers auto-deploy (~2–3 min). There is a brief 502 / blank-root swap window during restart.
- **Verify a deploy:** the frontend bundle hash changes (`dist/index.html` references new `index-*.js` / `Clients-*.js`); server health returns 200 after the swap. The server process can lag slightly behind the new frontend bundle.
- **Persistence:** SQLite DB lives on a Render persistent disk at `DB_DIR`.
- **Build:** `npm run build` = regenerate changelog + `vite build`.

---

## 4. Architecture

```
Browser (React SPA, PWA)
        │  authFetch (x-auth-token)
        ▼
Express (server/index.js)
        ├── /api/* routers (35 route modules)      → business logic
        ├── background scheduler (setInterval jobs) → syncs, digests, AI queue
        ├── server/ai-followup/*                    → HUB AI ISA engine
        └── better-sqlite3 (server/database.js)     → single-file SQLite master DB
        ▲
        │  pulls in / pushes back
External: Sierra · FUB · Twilio · SendGrid · Gmail IMAP · Google Calendar · Slack · Anthropic
```

- **Frontend** lives in `src/pages/*.jsx` (one file per tab) + shared components. Routes are declared in `src/App.jsx`.
- **Backend routers** live in `server/routes/*.js`, each mounted under `/api/<name>` in `server/index.js`.
- **Schema** is defined and migrated in `server/database.js` (idempotent `CREATE TABLE IF NOT EXISTS` + a `_migrations` runner).
- **Background work** is started by `startScheduler()` in `server/scheduler.js`.

---

## 5. Authentication & Access Control

**Two coexisting login paths (backwards compatible):**
- **Legacy shared login** — the single `TEAM_PASSWORD` still works and issues a stateless owner-scoped "team" token (`TOKEN_SECRET`, HMAC-SHA256, 30-day expiry).
- **Individual user accounts** (Phase 1, `server/auth/*` + `server/routes/users.js`) — per-user email + password login. Passwords hashed with **scrypt** (`server/auth/passwords.js`, no plaintext). Per-user tokens carry `uid`+`role`+`jti` and are tied to a **revocable session** (`user_sessions`).
- Frontend stores the token and sends it as `x-auth-token` on every request via `authFetch`.
- `requireAuth` verifies the token and attaches **`req.user`** (`{id, role, name, email}`; a legacy team token resolves to a full-access `owner` principal). Public exceptions: inbound Twilio/SendGrid webhooks, tracking pixels, and query-token media/recording/stream proxies.

**RBAC** (`server/auth/rbac.js`): roles = owner / admin / agent / transaction_coordinator / isa / marketing / read_only, each mapped to a permission set. Central `can(role, permission)` is the single authorization source; `requirePermission(perm)` guards routes (applied to `/api/users` now; rolled out to other routes incrementally).

**Audit log** (`server/auth/audit.js`, `audit_log` table): system actions — logins (success/failed/shared), user created/updated, role/status change, password reset, session revoke, permission-denied — captured with actor, IP, and user-agent. Communication content stays in its own tables, not here.

**User management** (`/api/users`, owner/admin only): list/create/update users, set roles, reset passwords, disable, revoke sessions; `/api/users/roles` and `/api/users/audit` for the UI. An initial OWNER is seeded on boot (`OWNER_EMAIL`/`OWNER_PASSWORD`, else the primary account + shared password) if the users table is empty.

*Follow-on increments: per-route permission enforcement everywhere, session-management UI (logout/revoke-all/login history), optional TOTP 2FA + recovery codes.*

---

## 6. Modules (Tabs) & Their Functions

Every tab is a React page backed by one or more API routers.

### Dashboard (`/`)
Team command center: at-a-glance counts (active transactions, tasks due, new leads), quick links, activity feed.

### Clients (`/clients`) — the CRM core
- Searchable/filterable client list; deep-link to a profile via `?open=<id>`.
- **Lead profile** with contact info, source, tags, status, FUB link, web activity ("Last Visit", viewed properties).
- **Communication buttons:** Text, Call, Email — each opens inline (no modal-behind-profile).
- **Inline Text composer** (`InlineTextComposer`): send SMS/MMS from the Hub number, insert templates, merge fields, attach photos, add more recipients, **loop in a teammate** (from the team agent directory), schedule for later.
  - **AI text suggestion** (newest): auto-drafts an SMS-appropriate message (first text / reply / follow-up aware), strict-Central greeting, compliance-aware, with Use this / Regenerate / Copy.
- **AI Suggested Follow-Up** (`🧭`): analyzes the client's history and recommends the next step + drafts a suggested email (regenerate / shorter / casual / direct / apply-context).
- **HUB AI ISA card:** enable/stop AI management per lead, preview, send-now (respects quiet hours), pause/resume/human-takeover.
- **Manual Dialer button (`☎ Dialer`):** dial any number not in the database.
- **Bulk actions:** bulk SMS, add to list, and **Power Dialer** (bulk call session).
- Editing is inline (name, phone, email, address) and writes through to the DB.

### Inbox (`/inbox`) — unified communications
- Unified thread view of **texts, emails, and calls** in one place.
- Channel filters (e.g. Text-only shows only texts, not emails from the same person).
- Inbound MMS photo rendering, link previews, AI badge on AI-sent messages.
- **Reply composer** adapts per channel: for text it hides Subject and adds template picker + insert-photo.
- **AI suggested response** for inbound texts.
- **View profile** button jumps to the lead's Clients profile.
- Assignment filters (Mine / assign to a team agent).
- Live updates via SSE stream.

### AI Opportunities (`/ai-opportunities`)
Surfaces leads the AI flags as worth acting on (high intent, re-engagement candidates).

### Power Dialer (`/dialer`)
Bulk call session engine (also reachable as a Clients bulk action): work a call list, log dispositions, custom voicemail greeting, live-call **voicemail drop**, call-list reporting.

### Transactions (`/transactions`) — TC system
- Master transaction tracker (buy/list side), representation type, key dates/deadlines.
- **Deadline → task sync**, walkthrough reminders, closing-invite emails.
- **AI email scrubbing / parsing** to pull deal data from inbound emails.
- Dotloop-aware; morning/afternoon TC digests to John and Matt.
- Transaction people (parties) tracked in `transaction_people`.

### Tasks (`/tasks`)
Task list with priorities, reminders (daily reminder emails to Matt/Leo), notify recipients, deadline-driven tasks from transactions.

### Projects (`/projects`), Notes (`/notes`)
Internal project tracking and freeform notes.

### Marketing (`/marketing`), Social Media (`/social-media`), Blog Posts (`/blog-posts`)
- Marketing campaign records.
- Social post generation/scheduling; auto-publish via **n8n** (Hub stores + schedules, n8n posts).
- Blog post management (the auto-publisher to Sierra runs as a separate tooling layer).

### Campaign Match (`/campaign-match`)
Matches leads to the right drip campaign (e.g. Past Client Nurture = Closed status only).

### Calendar (`/calendar`)
Shows Google Calendar events (synced from iCal feeds every 5 min).

### Templates (`/templates`)
- Email + text templates with merge fields.
- **FUB template import** (`/import-fub`): maps FUB tokens (`%contact_first_name%` → `{{first_name}}`, `%greeting_time%` → "Hi", etc.), skips Ylopo-link templates, updates existing imported ones.
- **Voicemail library** (upload/manage voicemail greetings and drops).

### Automations (`/automations`)
Workflow builder + execution engine (triggers, conditions, actions) **plus drip campaigns**. Enrollments, versions, executions, and event log are all tracked.

### Reporting (`/reporting`)
- **Texting** and **Calls** as separate tabs.
- **Campaigns** table (bulk text campaigns).
- Email engagement (SendGrid `messageActivityStats` — opens/clicks).
- **AI Follow-Up** tab: analytics, scheduler health, quality review (👍/👎 rating of AI actions).

### Vendors (`/vendors`), Partners (`/partners`)
Vendor and referral-partner directories.

### Updates (`/updates`), WhatsNew
Changelog / release notes surfaced in-app.

### Settings (`/settings`)
- **AI Follow-Up settings:** Autopilot toggle (OFF by default), feature flags, config (delays, quiet hours, persona, handoff threshold), diagnostics.
- **AI Exclusions:** search-with-suggestions chip picker (exclude by tag, status, or tag+status combination) so prospecting imports (FSBO / expired / cancelled) are never auto-contacted.
- **Team Agents:** manage the roster (name, phone, title) used for looping teammates into texts and for assignment.
- **Voice routing**, comms diagnostics.

---

## 7. HUB AI ISA (AI Inside Sales Agent)

A native AI real-estate follow-up + qualification system. **Manual-first and safety-gated:** every autonomous feature ships OFF; the AI only touches leads an agent explicitly enables until Autopilot is turned on.

### Engine modules (`server/ai-followup/`)
| Module | Responsibility |
|---|---|
| `policy.js` | Centralized compliance: `canSendSms`, `canAiCall`, opt-out application. Hard blocks always win. |
| `state.js` | 19 AI lead states, transitions, enable/stop/pause/resume, human takeover, exclusion logic. |
| `flags.js` | Feature flags + config defaults, quiet-hours math, autopilot check. |
| `intent.js` | Intent scoring (`computeIntent`, high-intent regex), history. |
| `context.js` | `buildLeadAiContext` + strict-Central `centralGreeting`. |
| `prompts.js` | Persona, style rules, buyer/seller playbooks, first-message directive. |
| `orchestrator.js` | The brain: inbound handling, proactive, follow-up, nurture, preview, finalize/guard. |
| `scheduler.js` | Drains the AI action queue; new-lead / re-engagement / behavioral sweeps. |
| `handoff.js` | Creates + notifies on human handoff at high intent. |
| `intent.js`, `memory.js`, `events.js`, `audit.js` | Intent, structured lead memory, event log, action audit trail. |

### Identity & voice
- Persona: **"John with Matt Smith Team at RE/MAX Concepts"** — never "the Matt Smith Team", never claims to be Matt.
- **First text** = warm time-of-day greeting + `MattSmithTeam.com` + the lead's search city + last viewed property; framed as "thanks for stopping by" (never surveillance-y "saw you browsing"); no city after the RE/MAX intro.
- **Follow-ups** open with "Hi"/"Hello" (never a time greeting, never "Hey"), and ask ONE qualifying question at a time: for buyers — area → price → property type → style → beds → timeframe → financing; for sellers — address → timeframe → motivation.

### Time & compliance guardrails
- **Strict Central time.** `centralGreeting()` is always `America/Chicago`. `finalizeAiText()` server-forces the correct greeting on the first text and strips any time greeting from follow-ups so the model can't override it.
- **Quiet hours** (default 21:00 → 08:00 CT) apply to ALL AI sends, including manual "Send AI now".
- **Hard text block** only when the lead texted STOP to the Hub number (`hub_text_opt_out`); `do_not_text` and `do_not_call` are independent; calling is never blocked by a text opt-out.
- **Exclusions:** imported prospecting lists (default `fsbo, mls: expired, mls: cancelled`, plus status and tag+status rules) are never auto-treated as new leads. An agent can still enable AI on one manually.

### Feature flags (all default OFF)
`ai_followup_enabled` (master), `ai_autopilot`, `ai_responsive_text_enabled`, `ai_proactive_text_enabled`, `ai_nurture_enabled`, `ai_behavioral_enabled`, `ai_voice_enabled` (future), `ai_auto_handoff_enabled`.

### Key config defaults
new-lead delay 5 min · first follow-up 10 min · max 4 follow-ups/day · quiet hours 21:00–08:00 CT · handoff intent threshold 70 · pause after human/after call · persona as above.

> **AI Voice** (Twilio ConversationRelay) is documented on the roadmap but intentionally not built until AI Text is stable in production.

---

## 8. Communications Center

- **Hub phone number:** +1 (319) 343-1562 (Twilio, A2P 10DLC verified).
- **Texting:** SMS + MMS via Twilio REST; templates, merge fields, media, scheduling, bulk campaigns.
- **Calling:** browser softphone (`window.hubCall`), call logging, dispositions, Power Dialer, live voicemail drop.
- **Voicemail:** custom greetings + a drop library (Templates tab).
- **Team agent directory:** Matt Smith (319-431-5859, Broker Associate), Hunter Caves (319-447-7337, Realtor), John Solamo (319-343-1562). Loop-in-a-teammate on any client text; agents skip the consumer compliance gate.
- **Inbound:** Twilio webhooks (signature-verified) for texts/calls; Gmail IMAP + SendGrid inbound for email.
- **Opt-out handling:** STOP routes through `policy.applyOptOut`; manual sends are tagged `sent_by_type='human'` and trigger human-takeover so the AI never talks over a live conversation.

---

## 9. Database (SQLite, master system of record)

Defined in `server/database.js`. Core tables:

**CRM & pipeline:** `clients`, `transactions`, `transaction_people`, `pre_listings`, `listings`, `realist_properties`, `showings`, `client_lists`, `lead_activity`, `activity_log`.

**Communications:** `communications` (+ `sent_by_type`, `ai_action_id`, `campaign_id`), `inbox_ai`, `text_campaigns`, `scheduled_texts`, `dialer_log`, `voicemails`, `team_agents`, `email_log`.

**HUB AI ISA:** `communication_preferences`, `ai_lead_state` (incl. `ai_managed`), `lead_intelligence`, `lead_events`, `ai_actions` (incl. `rating`), `ai_handoffs`, `ai_scheduled_actions`, `ai_intent_history`.

**Automations & drips:** `automations`, `automation_runs`, `automation_versions`, `automation_enrollments`, `automation_executions`, `automation_events`, `email_campaigns`, `drip_campaigns`, `drip_enrollments`, `drip_executions`, `followup_recommendations`.

**Content & ops:** `tasks`, `projects`, `notes`, `marketing`, `vendors`, `partners`, `social_posts`, `blog_posts`, `calendar_events`, `templates`.

**Integrations & system:** `fub_activity`, `sierra_sync_log`, `digest_log`, `app_settings` (flags/config), `_migrations`.

---

## 10. API Route Map

All under `/api`, guarded by `requireAuth` (except public webhooks/tracking):

`auth · seed · transactions · clients · tasks · projects · notes · marketing · showings · dashboard · pre-listings · listings · realist · vendors · partners · social-media · blog-posts · calendar · sierra · email · lists · templates · automations · reporting · drips · campaign-match · inbox · dialer · voicemails · ai · agents · followup · track`

Notable endpoints:
- `POST /api/ai/lead/:id/preview` — draft an SMS for a lead (used by the composer's AI suggestion + the AI ISA card).
- `POST /api/ai/lead/:id/send-now`, `/enable`, `/stop`, `/pause`, `/resume`, `/takeover`, `/settings`, `/facets` (exclusion picker suggestions).
- `POST /api/inbox/send` — send text/email; text branch accepts a `phones` array for raw agent numbers.
- `POST /api/fub/link/:clientId` — link a Sierra-origin client to its FUB person and backfill web activity.
- `GET/POST/PUT/DELETE /api/agents` — team agent directory.
- `POST /api/templates/import-fub` — import + token-convert FUB text templates.

---

## 11. Background / Scheduled Jobs

Started by `startScheduler()` (`server/scheduler.js`). All times drive off Central where user-facing.

| Job | Interval |
|---|---|
| Sierra incremental sync (leads updated since last sync) | every 60 min |
| Google Calendar (iCal) sync | every 5 min |
| Due scheduled texts | every 60 s |
| **AI action queue** (`runDueAiActions`) | every 60 s |
| AI new-lead sweep (autopilot only) | every 5 min |
| AI re-engagement + behavioral sweeps (autopilot only) | every 60 min |
| Transaction digest tick (morning/afternoon TC updates) | every 60 s (fires at target times) |
| Slack deadline alert (10 AM CT) | every 60 s (fires once/day) |
| Walkthrough reminder tick | every 60 s |
| Deadline → task sync | every 60 min |
| Backup tick | every 60 s (fires on schedule) |
| FUB web-activity incremental sync | every 60 min |
| FUB enrichment tick | every 20 min |
| FUB Realist Sell Score sync | every 7 days |
| FUB budget-range sync | every 7 days |

> AI follow-up runs on the server, so it works even when your computer is off — the queue drains on Render every 60 s.

---

## 12. Data Protection

5-layer backup strategy (added after a prior corruption incident):
- Bulk-mode syncs use a single atomic `saveDb()` (never `beginBulk/endBulk` on scheduled syncs without atomic save).
- Sierra incremental sync defers disk writes so all upserts flush as one write.
- Scheduled DB backups (`server/backup.js`) to `DB_DIR`, emailed to `BACKUP_RECIPIENTS`.
- Idempotent migrations via `_migrations`.
- Hub DB remains master; Sierra write-back is limited to status + tags.

---

## 13. Environment Variables

| Variable | Purpose |
|---|---|
| `PORT`, `DB_DIR` | Server port; SQLite persistent-disk directory |
| `TEAM_PASSWORD`, `TOKEN_SECRET` | Auth |
| `HUB_BASE_URL` | Public base URL for webhooks/links |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude AI (ISA, listings, transactions, follow-ups) |
| `SIERRA_API_KEY` | Sierra Interactive lead pull + write-back |
| `FUB_API_KEY` | Follow Up Boss (web activity, templates, custom fields) |
| Twilio creds | SMS/MMS, voice, voicemail (Basic auth to Twilio REST) |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_REPLY_TO` | Outbound email + engagement stats |
| `SLACK_WEBHOOK_URL` | Slack alerts |
| `GOOGLE_CALENDAR_ICAL_URL` | Calendar sync feed(s) |
| `TASK_REMINDER_MATT`, `TASK_REMINDER_LEO`, `TASK_NOTIFY_RECIPIENTS` | Reminder recipients |
| `TC_DIGEST_RECIPIENTS`, `TEAM_CLOSING_INVITE_RECIPIENTS` | TC digest + closing invites |
| `CLOSER_NAME/COMPANY/EMAIL/PHONE` | Closing email signature |
| `BACKUP_RECIPIENTS` | DB backup emails |

---

## 14. Running & Testing

```bash
npm run dev      # server + vite dev together (concurrently)
npm run server   # backend only
npm run build    # changelog + vite production build → dist/
npm start        # production: node server/index.js (serves API + dist)
npm test         # node --test test/comms.test.mjs test/hubai.test.mjs
```

- **Tests:** compliance model, do_not_text vs do_not_call independence, flag gating, force-bypass, AI state transitions, exclusions (tag/status/combination), quiet-hours boundaries, Central greeting, scheduler dedup, manual-mode.
- **SQLite rule:** never double-quote SQL string literals (single quotes only) with better-sqlite3.

---

## 15. Data Flow Summary

1. **In:** Sierra incremental sync pulls new/updated leads hourly; FUB syncs web activity, viewed properties, scores, budgets.
2. **Work:** the team texts/calls/emails inside the Hub; transactions, tasks, and notes are managed here; the AI ISA (when enabled per lead) drafts and sends compliant, Central-time follow-ups and hands off at high intent.
3. **Out:** lead status + tags write back to Sierra; the Google Sheet is display-only downstream, never a source for transactions.

---

## Client Profile workspace (`/clients/:id`)

A full-screen, routed CRM workspace for a single lead — being migrated in from the old
oversized modal (the modal still exists and remains reachable until parity is confirmed).

- **Route:** `src/pages/ClientProfile.jsx` at `/clients/:id` (real URL: direct access, refresh,
  back/forward, bookmarkable). Reuses HUB's existing sub-components + APIs — no duplicated
  SMS/email/AI/task/transaction/Sierra systems.
- **Reused components** (exported from `Clients.jsx`): `InlineName/InlineField/InlineStatus`
  (inline editing), `InlineTextComposer` (SMS: templates, merge fields, MMS, AI suggestions,
  scheduling, teammate loop), `ContactTimeline` (Activity), `AiIsaCard` (AI management),
  `QuickAddTask`, plus `COMM_META/commToText/fmtCommWhen/fmtDur/recUrl`.
- **Navigation state:** `src/lib/clientsNav.js` snapshots the Clients list state into
  sessionStorage when a lead is opened — `ids` (matched result set for **Prev/Next · X of Y**),
  `backLabel`, and `restore` (activeListId, search, advFilters) + scrollY. "← Back to Clients"
  restores exactly that view. Sort/pageSize/view/column widths/visibility/order already persist
  in localStorage and are owned by the Clients table (untouched by profile nav).
- **Tabs:** Overview (contact/CRM/AI-summary/FSBO listings/notes/research, 2-col desktop),
  Communications (All/Texts/Calls/Emails/Notes filters + search + composer, from
  `/api/inbox/thread/:id`), Activity (`ContactTimeline`), Transactions (`/api/transactions`),
  Tasks (`/api/tasks` + QuickAddTask), AI (`AiIsaCard`).
- **Migration status:** additive — row-click still opens the classic modal; the modal now has a
  "⤢ Full screen" button to the new route. Email/Add-Transaction full composers still live in
  the modal; port those, then flip row-click to the route and deprecate the modal.

---

*This document reflects the live codebase as of 2026-08-21 (Client Profile workspace added 2026-08-27). When features change, update this file alongside the code.*
