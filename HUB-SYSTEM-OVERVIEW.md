# Matt Smith Team — Hub System Overview

**Real Estate Command Center** for the Matt Smith Team (RE/MAX Real Estate Concepts, Cedar Rapids / Marion, Iowa).
This is the single source of truth for how the Hub is built, what it does, the thinking behind it, and every moving part.

- **Live app:** https://realestate-hub-1rzu.onrender.com
- **Repo:** github.com/Traditions2025/realestate-hub
- **Version:** 2.0.0
- **Last documented:** 2026-09-14

---

## 1. What the Hub Is

A self-hosted CRM + operations platform that sits on top of the team's existing lead sources (Sierra Interactive, Follow Up Boss) and communication rails (Twilio, SendGrid, Gmail). It is **the master system of record** for the team's daily workflow: leads, conversations, transactions, tasks, prospecting lists, drip campaigns, and the AI follow-up layer. It replaced a patchwork of spreadsheets, Zapier flows, and manual copy-paste with one installable web app.

Core loop: leads and web activity flow IN from Sierra, FUB, and the MLS master files; the team works them inside the Hub (texting, calling, email, tasks, transactions, AI follow-up, connection campaigns); status flows BACK OUT to Sierra.

---

## 2. The Overall Thinking (design principles)

These are the rules that shaped every subsystem. They are enforced in code, not just convention.

1. **The Hub DB is master.** Transactions are never synced from the Google Sheet. Sierra supplies leads and its own signals; it can never overwrite what the team edits in the Hub (see Field Ownership, §12).
2. **History is never destroyed.** Communications, FSBO listing history, notes, and campaign logs are permanent parts of the relationship record. Leaving a list clears list *membership*, never the data (learned the hard way; now structural).
3. **Automation is manual-first and safety-gated.** Every autonomous feature ships OFF behind a flag or master switch. Compliance (STOP, DNC, quiet hours, holidays, undeliverable numbers) is centralized in one policy layer that every send path must consult — hard blocks always win.
4. **Evaluate before every send, not just at enrollment.** Campaigns re-check eligibility (property status, conversation history, manual human activity, opt-outs) before each individual message. Enroll-once-blast-forever does not exist here.
5. **Persistence ≠ pressure.** Outreach campaigns create more *chances to respond*, never more sales pressure. Message 10 is no more aggressive than message 1. The moment a lead replies, automation stops and a human takes over.
6. **The AI never speaks to delicate leads.** Cancelled/Expired campaign leads are triple-fenced from AI replies (webhook skip, orchestrator gate, policy deny). The AI's job on those is deciding *whether/which approved message* — never composing to the seller.
7. **Texts trickle, never blast.** Automated text campaigns pace 1–2.5 minutes between leads with randomized send days/times, and re-check the weekday 9AM–4PM Central window before every single send.
8. **One authoritative evaluator per concept.** Follow-up coverage, eligibility, phone compliance — each has exactly one implementation that every surface (dashboard, smart lists, profile cards) calls. No re-derived logic.
9. **All times are Central.** Greetings, windows, schedules, digests.
10. **Verify live, test the class.** Every change ships with tests (207 across 19 suites), deploys are gated on the changelog hash, features are verified in the deployed app (often by screenshot), and when a bug class appears twice it gets a permanent guard test (e.g. the React hook-import scanner).
11. **Never guess identity.** Skip-traced numbers are only accepted when Forewarn's address history proves the person; campaign texts reference "the home at {address}", never "your home", until the recipient establishes themselves.

---

## 3. Tech Stack & Tools

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite (JSX), React Router 6, single CSS system (`src/styles/app.css`) |
| Backend | Node.js + Express 4 (ESM modules) |
| Database | better-sqlite3 (single-file SQLite, ~40 MB, atomic saves) |
| AI | Anthropic Claude (`@anthropic-ai/sdk`), model via `ANTHROPIC_MODEL` |
| Texting / Calling | Twilio (REST) + Twilio Conversations (group MMS) |
| Email (outbound) | SendGrid (+ Event Webhook engagement tracking) |
| Email (inbound) | Gmail IMAP (`imapflow` + `mailparser`) and/or SendGrid Inbound Parse |
| Mobile | PWA (installable); responsive layer; no native shell |
| Hosting | Render (auto-deploy on `git push`, persistent disk for the DB) |
| Automation glue | n8n (social publishing), legacy Zapier |

**External systems:** Sierra Interactive API (leads in, status back) · Follow Up Boss API (web activity, notes, templates, custom fields) · Twilio · SendGrid · Google Calendar (iCal) · Slack (alerts) · Anthropic Claude · Forewarn (via the separate `mls-expired-cancelled/` tooling) · Google Sheets master files (FSBO + Expired/Cancelled).

---

## 4. Hosting, Deployment & Process

- **Host:** Render web service. `npm start` → `node server/index.js`; Express serves both the API and the built React bundle from `dist/`.
- **Deploy:** `git push origin HEAD` auto-deploys (~1–3 min). A brief 502/blank swap window occurs; rolling swaps can drop in-flight webhook writes (a 10-min group-thread resync heals those).
- **Deploy gate (team practice):** after pushing, poll `GET /changelog.json` until it contains the new commit hash, then verify the feature live. Never assume.
- **Pre-deploy check:** confirm no sync/import/digest node process is running locally.
- **Build:** `npm run build` = regenerate changelog + `vite build`.
- **Process:** test-first where practical (red → green), full suite before deploy, commit messages describe the why, memory/docs updated when architecture changes.

---

## 5. Architecture

```
Browser (React SPA, PWA)
        │  authFetch (x-auth-token)
        ▼
Express (server/index.js)
        ├── /api/* routers (37 route modules)       → business logic
        ├── background scheduler (setInterval jobs)  → syncs, sweeps, campaigns, digests
        ├── server/ai-followup/*                     → HUB AI ISA engine
        ├── server/cx-connect.js                     → Cancelled/Expired connection campaign
        ├── server/followup-coverage.js              → coverage evaluator
        ├── server/fsbo-master.js / expired-master.js→ master-file syncs
        └── better-sqlite3 (server/database.js)      → single-file SQLite master DB
        ▲
External: Sierra · FUB · Twilio · SendGrid · Gmail IMAP · GCal · Slack · Anthropic · Google Sheets
```

- **Frontend:** `src/pages/*.jsx` (one file per tab) + shared components; routes in `src/App.jsx`. The global shell = sidebar nav, centered Search-everything bar, top-right utility cluster (🔔 notifications + user avatar/account menu).
- **Backend routers:** `server/routes/*.js`, mounted under `/api/<name>`.
- **Schema:** defined + migrated idempotently in `server/database.js` (try/catch `ALTER`s; indexes created only after their tables).
- **Theme system:** semantic accent tokens with 5 themes (Matt Smith Gold default, team-wide setting + per-user override, pre-paint boot script), dark/light via `body[data-theme]`.

---

## 6. Authentication & Access Control

- **Per-user accounts only** (the shared team login was retired 2026-09-04 and legacy team tokens are rejected). Passwords scrypt-hashed; 30-day tokens carry `uid`+`role`+`jti` tied to revocable `user_sessions`. Sent as **`x-auth-token`** on every request (not Authorization Bearer).
- **RBAC** (`server/auth/rbac.js`): owner / admin / agent / transaction_coordinator / isa / marketing / read_only → permission sets; `requirePermission()` guards admin routes; full **audit log** of auth/system actions.
- **User management** (`/api/users`, owner/admin): create/update users, roles, password resets, session revocation.
- **Self-service profile** (`/api/users/me`): own name/phone + avatar (client square-crops to 256px; server validates MIME + size; stored on the user row). The **header account menu** (avatar next to the bell) holds Profile, Settings, Light/Dark, Log Out.
- **Automation account:** `automation@mattsmithteam.com` (admin) — all API tooling authenticates as this user; creds live in the project memory folder.

---

## 7. Frontend Modules (Tabs)

### Dashboard (`/`)
"What should I do first?" — action cards (Priority Leads, Need Response, AI Handoffs, Follow-Ups Due, Appointments, Overdue Tasks), **Needs Your Attention** (collapsible, 3 by default; excludes internal team records), **Cancelled/Expired/FSBO Updates** box (today's master-file changes with clean labels, full address, DOM, View-Listing links + a Check Master Files Now button), Lead Pipeline chips deep-linking into Clients, Transactions & deadlines, Opportunity Radar (re-engaged 60d+, repeat viewers, past clients active — FUB-driven), HUB AI stats, Communication Health, Follow-Up Coverage KPI (*connected leads without future coverage — target 0*), Business Performance (owner/admin), System Health. Today's Schedule sits minimized at the bottom.

### Clients (`/clients`) — the CRM core
- **List:** status tabs + smart lists + saved lists (static or dynamic-filter). **Name column is pinned** — always first and sticky during horizontal scroll. Columns + widths are **per view** (each tab/saved list/smart list remembers its own). Column picker is a compact 2-column popover with reset/auto-fit. Select Visible / Select first 100–500 / Select All Matched. Comm-recency columns + sorts (Last Text/Email/Call, Last Email Received/Sent, opens/clicks).
- **Cancelled/Expired list** has its own column set (Off Market Date, MLS Status, MLS #); FSBO list injects FSBO Status (Available/Off Market) + Price + live DOM.
- **Lead profile** (`/clients/:id`, full-screen route): draggable two-column card layout (per-user, persisted) with **Client Details locked first**; Communications box with All/Texts/Calls/Emails/**Notes** tabs (notes live here, not a separate box); Buyer/Seller profile; Property Activity; Website/FUB/Sierra activity; Follow-Up Coverage card; **Cancelled/Expired Campaign card**; AI card; Action Plans; Tasks; Transactions.
- **Contact fields:** primary + **additional phones/emails** (＋ beside the pencil), **nicknames per additional number** ("Wife - Sarah") shown in every picker, editable via chips.
- **Texting from the profile:** number picker with nicknames, **"+ Add another number…" inline**, and a **👥 all-N-numbers group toggle** that sends one true group MMS to every saved number (survives adding teammates; extra numbers appear as chips). **Call ▾ picker** when 2+ numbers. Full composer: templates, merge fields, MMS, scheduling, teammate loop-in, AI text suggestion.
- **Email from the profile:** composer with templates/merge fields/preview, **✨ Suggested reply** (same engine as Inbox — works even when the lead has never replied: drafts a first-outreach opener), angle chips (Continue conversation / Website activity / Soft check-in), **adjust row** (Shorter/Casual/Direct/Warmer + free-text context), Reply buttons on every email in history.
- **Address intelligence:** pasting a full address into Address auto-splits street/city/state/zip and fixes casing; state abbreviations always ALL CAPS.

### Inbox (`/inbox`)
Unified texts/emails/calls. Email threads show **only the current exchange** (latest inbound + every reply after it; older mail lives on the profile with a count pill). Thread header shows a **seller-context pill** (CANCELLED / EXPIRED / WITHDRAWN / FSBO + status) for listing leads. Reply picker shows number nicknames. **Group MMS threads** with per-message sender attribution (**name + number**), delivery receipts per recipient, 10-min self-healing resync from Twilio's record. AI suggested replies with adjust/context. Unknown-sender queue with create/link-to-lead.

### Other tabs
- **AI Opportunities / AI Sandbox** — AI-flagged leads; sandboxed prompt experiments.
- **Power Dialer** — bulk call sessions, dispositions, voicemail drop.
- **Transactions** — the TC system: tracker, deadlines→tasks, digests (9AM/1PM CT), AI email parsing, closing invites.
- **Tasks / Projects / Notes** — ops basics; annual Not-in-Market recheck loop lives in Tasks.
- **Automations** — workflow builder + execution engine + drip campaigns (enrollments/versions/executions/events).
- **Marketing / Social / Blog / Campaign Match / Calendar / Templates / Vendors / Partners / Reporting / Updates / Duplicates / Admin** — as before; Reporting includes texting, calls, campaigns, email engagement, and AI quality review.
- **Settings** — collapsible two-column categories: General (account + signature) · Appearance (accent themes; team default + personal override) · AI Follow-Up (ISA flags, **CX campaign master switch + bulk enroll + stats**, coverage standards, regression eval) · Communications (Twilio, routing, A2P) · Email & Inbox (mailboxes) ·· Team & Users · Data / Imports (**Sierra Full Sync**, master-file check button, Realist CSV import) · System / Diagnostics.

---

## 8. HUB AI ISA (AI Inside Sales Agent)

Native AI follow-up + qualification. **Manual-first:** every autonomous feature ships OFF; the AI only touches leads an agent enables (or Autopilot, when on, for non-excluded new leads).

- **Engine** (`server/ai-followup/`): policy (compliance) · state (19 lead states) · flags · intent scoring · context/prompts (persona "John with Matt Smith Team at RE/MAX", strict-Central greetings, one-question-at-a-time playbooks) · orchestrator (the brain) · scheduler (queue + sweeps) · handoff (notify at intent ≥ 70) · memory/events/audit.
- **Cold-seller philosophy:** FSBO/expired/cancelled = relationship, not pitch — overrides discovery/objection playbooks.
- **Cold buyer drip:** staged SMS revive (Day 1/4/9/17/30/50 + long-term nurture), weekdays only, autopilot+nurture gated.
- **Guardrails:** quiet hours 21:00–08:00 CT on all AI sends; STOP-to-Hub-number is the only text hard-block (calling never blocked); prospecting imports are excluded from auto-treatment; `finalizeAiText` server-forces greetings; **CX-campaign leads are never AI-texted or AI-answered, ever** (three independent fences).
- **AI-assisted, human-sent surfaces:** Inbox/profile Suggested replies and the Suggested Follow-Up card share one dossier built from Hub data + **Hub notes + notes-table records + Sierra lead notes (live) + FUB notes/calls/emails/texts/events** — so drafts are grounded in real history even for leads with zero web activity. Drafts are never auto-sent.

---

## 9. Cancelled/Expired Connection Campaign ("CX Connect") — LIVE

`server/cx-connect.js` + `/api/cx` + profile card + Settings card. Purpose: **make contact** with cold Cancelled/Expired sellers; persistence = more chances to respond.

- **Pipeline (fully automatic since 2026-09-14):** hourly master-file sync tracks a new cancellation/expiry → creates the lead → **hourly auto-enroll pass** screens and enrolls it (notification announces joiners) → Day-1 intro at the next trickle slot → replies stop everything for a human.
- **Eligibility, re-verified before EVERY send:** skips prior responders (full conversation-history scan: rented/sold/other-agent/keeping/not-interested/wrong-number/future-timeframe), STOP/DNC, undeliverable landlines, Sold/Pending/Active-relisted MLS status, junked leads, no-address, merged records, AI-managed leads; recent manual human contact defers (never talks over you); central collision gate adds dedup/quiet-hours/holiday. Human pause/remove/response can never be silently re-enrolled.
- **Cadence:** Day 1 intro → day 2–3 second attempt → ~weekly forever while eligible, with 6–8-day jitter, random in-window times, Sat→Fri/Mon, Sun→Mon. **Trickle: 1–2.5 min between sends**, window (weekday 9AM–4PM CT) re-checked per send.
- **Language:** approved template library only — 18 rotating angles (no repeat within last 3), age-bucketed by off-market date (0-30 recent / 31-90 / 91-365 / 365+; unknown date = old-listing language; buckets migrate automatically). Street-address only, no names, no ownership assumptions, no activity questions, no manufactured hooks, never "recently" on old listings.
- **Response = STOP FIRST:** inbound instantly halts that lead, classifies internally (keywords, no model in the path), notifies + creates a high-priority **CX Response task**. The AI never replies — the human does.
- **Ops:** master switch (Settings), per-lead card (status incl. RESPONSE RECEIVED banner, next send, attempts, angle, log, pause/resume/remove), dry-run preview endpoint (`GET /api/cx/preview`) that composes real next texts without sending, full decision/audit log (`cx_campaign_log`) powering future angle/day/time analytics.
- **Companion:** "Second Act" email drips (0-30/31-90/90+; 30 emails each) exist and render clean but are enrolled separately (currently not enrolled).

---

## 10. Follow-Up Coverage (fall-through prevention)

One authoritative evaluator (`server/followup-coverage.js`) answers per lead: *"if we do nothing manually, will this person hear from us again — and soon enough?"* Valid coverage = future task / scheduled text / pending AI action / active drip-automation with a future run / active transaction / intentional snooze / documented exclusion — with channel sanity (SMS coverage never counts for a text-opted-out lead). Relationship levels ratchet at *connected*; silence windows are configurable per level; states protected / at_risk / unprotected / snoozed / excluded. 10-min incremental sweep + chunked daily audit + immediate recalc on the classic fall-through moments (last task completed, status change). Surfaces: Dashboard KPI + attention items, smart lists, opt-in columns, profile card. The evaluator never sends anything.

## 11. Not in Market (CRM status)

Hub-native status for "we connected and they confirmed no current intent." One centralized transition stops drips/automations/scheduled texts/AI, sets intent LOW, closes sales-patterned tasks, and creates ONE annual recheck task (self-renewing loop on completion). Sierra can never overwrite it; drips refuse these leads; coverage counts the annual task as protection. Distinct from Watch (future intent) and from opt-out ("never contact me").

---

## 12. Sierra Sync — Field Ownership (2026-09-11)

The hourly incremental sync (updated + created passes, bulk-mode atomic save) now follows a strict ownership doctrine:

- **Existing leads:** the sync writes ONLY what Sierra owns — status (junk safety, Not-in-Market-guarded), website visits, email/phone validation statuses, Sierra dates/pond, marketing/text/ealert opt-outs, summary, tags, lender fields, saved-search criteria. It **never replaces** name, email, phone, address, type, budgets, agent assignment, or Realist score/grade — Hub edits to contact data are permanent. One exception: an **empty** Hub phone/email/address is backfilled from Sierra (new website-provided data, never an overwrite; `notvalidemail` placeholders excluded).
- **New leads:** insert in full.
- **Hub → Sierra:** status (and tags) push back on change; nothing else.
- Why: a sync pass silently reverted 39 Forewarn-verified phone numbers the day after they were written. Now structurally impossible.
- **Corollary for the team: contact edits happen in the Hub.** Corrections made inside Sierra no longer flow onto existing leads.

## 13. Master-File Prospecting Syncs

- **FSBO** (`server/fsbo-master.js`, ~hourly): Google Sheet → `fsbo_status` (phone-matched), listing groups (`fsbo_listings` JSON), price/DOM/link/notes; logs New/Price Reduction/Price Increase/Status change/Removed to `master_file_updates` + profile notes; phone-collision guard; name+phone self-heal dedupe. **Dropping off the file clears membership only — listing history stays forever** (and a one-time restore endpoint rebuilt the 22 profiles the old prune had wiped).
- **Expired/Cancelled** (`server/expired-master.js`, ~hourly): master sheet (reads the `MLS Status` column; the `Status` column is the team's Watch/Junk workflow) → creates leads, stamps off-market date/MLS #/listing agent, junks relists, logs New/Relisted with Cancelled/Expired/Withdrawn subtypes. Feeds the dynamic Cancelled/Expired list → **CX campaign auto-enroll**.
- The sheets themselves are produced by the separate daily `mls-expired-cancelled/` tooling (MLS pull → screens → Forewarn phone lookups with the address-verification safety rule + deep address-history recovery for movers → sheet). The Hub never writes the sheets.

---

## 14. Communications Center

- **Hub number:** +1 (319) 343-1562 (Twilio, A2P verified). Team: Matt (319-431-5859), Hunter (319-447-7337), John (Hub line).
- **Texting:** SMS/MMS, templates, merge fields, scheduling (compliance re-checked at send time), bulk campaigns, teammate loop-in.
- **Group MMS** (Twilio Conversations): real shared threads (`grp_<sid>`); exact-participant-set reuse; per-message sender name + number; per-recipient delivery receipts; 10-min webhook-healing resync; participants who can't join (Twilio's one-group-per-number rule) automatically get a **labeled 1:1 copy**. Group threads surface on every member's profile.
- **Calling:** browser softphone, dispositions, Power Dialer, live voicemail drop; calling is never blocked by text opt-outs.
- **Inbound text pipeline** (webhook, signature-verified): undeliverable-flag self-clear → STOP/START + natural-language opt-out via policy → store → notify (+web push) → behavioral event → **CX stop-first hook** → FSBO scripted reply → automation triggers → HUB AI responsive (skipped for CX leads).
- **Line intelligence:** undeliverable/landline verdicts belong to the *number* — replaced numbers shed the old verdict and STOP flag automatically.
- **Notifications:** in-app bell + optional web push; inbound texts/emails, CX responses/enrollments, handoffs.

## 15. Email System

- **Outbound:** SendGrid with open/click tracking; drips/sequences (`sendSequenceEmail`), transaction/pre-listing mail (team CC), composer sends. **Every client-facing send is logged to the profile thread** (`logSentToInbox`; pre-Aug-7 history was backfilled — 250 emails restored). **Auto-BCC to matt@mattsmithteam.com on human-sent emails** (Inbox replies + one-offs; never drips). `{{time_greeting}}` and rotating greetings across 72 drip templates; Comeback V2 steps window 9:00–16:00.
- **Engagement:** SendGrid Event Webhook → `email_events` (idempotent, signature-verified) → summaries on `email_log` + client rollups; surfaces in Clients columns/filters/smart lists, Inbox chips, profile timelines, Reporting. Opens are soft signals; clicks strong; both feed AI intent.
- **Inbound:** Gmail IMAP + Inbound Parse; store-time quoted-history stripping (strict HTML detection) so threads show only the new message; lead-profile button on notify emails.

---

## 16. Database (SQLite, master record)

Core groups (all in `server/database.js`):
- **CRM:** `clients` (incl. `alt_phones`, `alt_phone_labels`, `phone_sierra_shadow`, FSBO fields, `off_market_date`, `mls_status`, `not_in_market_at`), `transactions`, `transaction_people`, `client_lists` (static + dynamic), `notes`, `tasks`, `showings`, `activity_log`, `master_file_updates`.
- **Comms:** `communications` (unified thread; `sent_by_type`, `conversation_sid`, `group_meta`), `scheduled_texts`, `text_campaigns`, `dialer_log`, `voicemails`, `team_agents`, `email_log`, `email_events`, `inbox_ai`, `notifications`.
- **AI:** `ai_lead_state`, `ai_actions`, `ai_scheduled_actions`, `ai_handoffs`, `ai_intent_history`, `lead_intelligence`, `lead_events`, `communication_preferences`, `followup_recommendations`.
- **Campaigns:** `drip_campaigns/enrollments/executions`, `automations*`, **`cx_campaign` + `cx_campaign_log`**, `followup_coverage` + `_events`.
- **System:** `users` (avatar), `user_sessions`, `audit_log`, `fub_activity`, `sierra_sync_log`, `app_settings`, `_migrations`.

Rules: single-quoted SQL literals only; migrations are idempotent try/catch ALTERs; indexes after their tables; scheduled syncs use bulk mode **only** with the atomic save pairing.

## 17. API Route Map

All under `/api`, behind `requireAuth` (public: inbound webhooks, tracking, query-token media):

`auth · users (admin + /me self-service) · clients · transactions · tasks · projects · notes · showings · dashboard · listings · pre-listings · realist · vendors · partners · marketing · social-media · blog-posts · calendar · sierra · email · lists (incl. master-file + FSBO restore) · templates · automations · drips · campaign-match · reporting · inbox (incl. group-text/receipts/resync) · dialer · voicemails · ai · agents · followup · coverage · cx (campaign: stats/preview/toggle/enroll-list/:id actions) · admin · seed · track`

## 18. Background Jobs (`server/scheduler.js`)

| Job | Interval |
|---|---|
| Sierra incremental sync (field-ownership rules; FSBO + Expired master syncs piggyback ~hourly) | 60 min |
| **CX campaign sweep** (auto-enroll hourly pass + trickle sends, self-gated) | 15 min |
| FSBO smart follow-up sequence | 15 min |
| Follow-Up Coverage sweep / daily audit | 10 min / hourly check |
| Group-thread resync | 10 min |
| Google Calendar sync | 5 min |
| Scheduled texts · AI action queue | 60 s |
| AI new-lead sweep · re-engagement/behavioral sweeps | 5 min / 60 min (autopilot only) |
| TC digests · Slack deadline alert · walkthrough reminders · backups | 60 s ticks firing at target times |
| Deadline→task sync · FUB activity/enrichment | 60 min / 20 min |
| FUB Realist-score + budget syncs | 7 days |

## 19. Data Protection

Atomic `saveDb()` everywhere (bulk mode only with the atomic pairing) · scheduled backups emailed + on-disk · idempotent migrations · Hub-is-master doctrine · field-ownership guard against sync overwrites · audit log · 5-layer strategy born from the 5/11 corruption incident.

## 20. Running & Testing

```bash
npm run dev / server / build / start
npm test   # 19 suites, 207 tests
```
Suites: comms & compliance, HUB AI (+scenarios), auth/RBAC, collision guard, failures/backup, routing, memory classifier, smart audiences, AI eval, FSBO master, behavioral, **coverage**, **address parser**, **not-in-market**, **cx-connect (23: history suppression, buckets, weekend/jitter scheduling, response-stops-everything, AI-never-replies, angle rotation, auto-enroll)**, **hook-imports guard**, **phone-shadow / sierra-field-ownership**.

## 21. Data Flow Summary

1. **In:** Sierra sync (leads + Sierra-owned signals) · FUB (web activity, notes, scores) · master files (FSBO + Cancelled/Expired prospects) · inbound texts/emails/calls.
2. **Work:** the team operates in the Hub — conversations (individual + group), tasks, transactions, campaigns; the AI drafts and (only where enabled) sends compliant follow-ups; CX Connect persistently works cold sellers; coverage watches that nobody falls through.
3. **Out:** status/tags to Sierra; texts/emails/calls to leads (trickled, windowed, compliance-gated); alerts to Slack; digests to the team.

---

*Reflects the live codebase as of 2026-09-14. When features change, update this file alongside the code.*
