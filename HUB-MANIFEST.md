# Matt Smith Team — Real Estate Hub: System Manifest

*A full accounting of what the Hub is, how it's built, what it connects to, and every feature it runs.*
*Team: Matt Smith Team, RE/MAX Real Estate Concepts — Cedar Rapids / Marion, Iowa.*
*Last compiled: 2026-08-07.*

---

## 1. What it is

A single, custom web application that acts as the team's command center — a lightweight CRM + operations layer that sits **on top of** Sierra Interactive and Follow Up Boss rather than replacing them. It unifies leads, transactions, an email/text inbox, tasks, marketing, automations, and reporting, and layers AI (Claude) on top for follow-up recommendations and email drafting.

- **Live URL:** https://realestate-hub-1rzu.onrender.com
- **Access model:** single shared team password (one login for the whole team)
- **Installable:** yes — it's a mobile PWA (add-to-home-screen app), fully responsive
- **Scale today:** ~45,800 leads, ~65 MB database

---

## 2. Architecture & tech stack

| Layer | Technology |
|---|---|
| Frontend | **React 18** + **Vite 6** (plain JavaScript/JSX, no TypeScript), React Router, lazy-loaded pages |
| Backend | **Node.js + Express** (ES modules) |
| Database | **sql.js** — SQLite compiled to WebAssembly, held in memory, serialized to a single file on disk |
| Hosting | **Render** (single web service + a 5 GB persistent disk mounted at `/data`) |
| Source control / CI | **GitHub** (repo `Traditions2025`), auto-deploy on every push to `main` (~2–3 min redeploy) |
| Email delivery | **SendGrid** |
| Rich text | Custom RichTextEditor + EmailToolbar components |
| Images (server) | **sharp** (icon generation, etc.) |
| AI | **Anthropic Claude** via the official SDK (`@anthropic-ai/sdk`) |

**Codebase size (own code, excludes dependencies/build):** ~7.1 MB
- Server: **~14,200 lines** across 43 JS files
- Frontend: **~14,300 lines** across 38 files (app.css alone ~3,900 lines)
- Deployed bundle: ~170 KB gzipped JS (lazy-loaded per page) + ~65 KB CSS

---

## 3. Data & storage

- **Database file:** `/data/realestate-hub.db` (~65 MB), one SQLite file holding all tables.
- **Save model:** atomic writes (write to temp → fsync → rename) so a crash mid-save can't corrupt the DB. This was hardened after a data-loss incident on 2026-05-20.
- **Key tables:** `clients` (leads), `transactions`, `tasks`, `communications` (inbox), `email_campaigns` / `email_log`, `templates`, `drip_campaigns` / `drip_enrollments` / `drip_executions`, `automations` / `automation_enrollments` / `automation_executions` / `automation_events`, `fub_activity`, `followup_recommendations`, `inbox_ai`, `blog_posts`, `vendors`, `partners`, `activity_log`, `sierra_sync_log`, `app_settings` (key-value config).
- **5-layer backup strategy** (post-corruption safeguard):
  1. Nightly email backups (DB emailed to recipients)
  2. Pre-boot snapshots (a full copy taken on every server restart; last 10 kept)
  3. Daily on-disk backups (kept ~2 weeks)
  4. Migration ledger + integrity checks on boot (auto-restores from the newest clean backup if the primary is corrupt)
  5. `/api/health` + `/api/db-status` endpoints for live monitoring
- **Disk usage today:** ~1.47 GB of 5 GB (29%) — the 65 MB DB plus ~1.35 GB of backup copies.

---

## 4. Authentication & security

- **Auth:** one shared `TEAM_PASSWORD`; a token (`TOKEN_SECRET`) is issued on login and sent as `x-auth-token`. No per-user accounts or roles (single-team design).
- **Secrets:** all API keys live server-side in environment variables (and some in the `app_settings` table); never in frontend code or git.
- **Global resilience:** an `unhandledRejection` handler keeps the app alive through stray async errors instead of crashing (added after a Render "Exited with status 1" incident).

---

## 5. Integrations & connectors

| Connector | What it does | How it's wired |
|---|---|---|
| **Sierra Interactive** | Primary CRM/source of leads. Pull leads, notes (MLS #s live here), saved listings; push status changes back (e.g. → Junk). | REST API (`api.sierrainteractivedev.com`, `Sierra-ApiKey` header). Hourly incremental sync + on-demand. Cloudflare-blocks non-server IPs, so only the Render server can call it. **Webhooks are not available** on this account (API returns 404), so sync is poll-based. Sierra's API exposes leads/notes/listings only — **no email/text/call history**. |
| **Follow Up Boss (FUB)** | Communication + relationship history: notes, calls + outcomes, emails, **text messages**, tasks, appointments, stage, tags, source, property-view activity. | REST API (`api.followupboss.com/v1`, Basic auth). Read-only. Feeds the AI features and property-view emails. This is where texts/calls actually live (Sierra has none). |
| **SendGrid** | All outbound email; retroactive open/click/bounce stats; optional inbound email parsing. | Outbound via API with per-send category tags (`camp_*`, `drip_*`, `auto_*`) so Reporting can pull engagement. Email Activity API used for opens/clicks. Inbound Parse endpoint available (needs DNS). |
| **Gmail (IMAP)** | Real-time incoming client emails into the Inbox, with **no DNS setup**. | `imapflow` + `mailparser` over an App Password. Two mailboxes connected: `mattsmithremax@gmail.com` and `matt@mattsmithteam.com`. Polled every ~60s; only stores emails whose sender matches a client. |
| **Google Calendar** | Calendar events auto-synced into the Hub. | Read-only iCal feed (`GOOGLE_CALENDAR_ICAL_URL`), refreshed every 5 min. |
| **Slack** | Team alerts (deadlines, transaction tasks). | Incoming webhooks (`SLACK_WEBHOOK_URL`), e.g. `#transaction-tasks-deadlines`. |
| **Anthropic Claude** | The AI brain (see §6). | Official SDK, model via `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`). |
| **Twilio** | Business registration (A2P) staged in Settings; texting/SMS is the next feature. | Business Registration captured; **texting is "coming soon"** (Inbox shows a Text channel placeholder). |
| **Realist** | Property data enrichment (home values, sale prices, sell score). | CSV upload → matched to clients by address. |
| **Zapier** | Legacy automation glue (lead scoring wiring). | External. |

> Note: A prior Google Sheets sync path was **disabled** — the Hub DB is the single source of truth for transactions/pre-listings (those sync endpoints return 410 Gone).

---

## 6. AI layer (Claude)

All AI runs server-side through Claude, grounded strictly in the client's own records (no fabrication), with a house style: warm, personal, no corporate filler, and **never uses em dashes**.

- **Suggested Follow-Up (client dashboard):** blends HUB data + FUB history into a dossier and produces a recommended next step (call / email / text / send property / market update / schedule / complete task / **wait** / no action), the factual "why," a relationship summary, and an editable follow-up email. Cached per client; runs only on first open or manual refresh. Editable with tone controls + a free-text "add context" box.
- **Inbox Suggested Response:** reads an incoming email + the full thread + client context, classifies intent (Needs Response / Question / Scheduling Request / Property Interest / High Intent / Information Request / No Response Needed), summarizes it, and drafts a reply. Editable with Regenerate / Shorter / Casual / Direct / Warmer / Add-context; drafts persist per thread.
- **Marketing/listing copy + transaction + blog generation** also use Claude.
- **Cost control:** AI never runs on every page load — results are cached and only regenerated on meaningful new activity or explicit refresh.

---

## 7. Modules (the app's tabs)

| Module | What it does |
|---|---|
| **Dashboard** | Command center: under-contract / active / closed counts, monthly volume, active buyers/sellers, overdue tasks, pre-listings, recent activity. |
| **Transactions** | The single pipeline for all listing states (pre-listing → active → under contract → closed). Hub is the master record. Kanban + detail. |
| **Clients** | The lead database (~45.8k). Filters, saved lists, column customization, bulk actions (apply drip/automation, set status), Sierra sync + Realist import, and the rich per-lead profile with activity, viewed properties, Active Plans, and the AI Suggested Follow-Up. |
| **Inbox** | Unified calls/texts/emails (only messages matched to a client). Threads, folders (Inbox/Sent/Closed), channel filters, compose, real-time incoming email (Gmail IMAP), **reply from the Hub with AI Suggested Response**, and an email notification when a client emails in. All outbound client emails are logged here under Sent. |
| **Tasks** | Team task tracker with priorities; Slack + email reminders. |
| **Projects / Notes** | Internal project boards and notes. |
| **Automations** | Visual workflow builder (Sierra/Zapier-style) + a real per-contact execution engine: triggers (property viewed, contact created, tag/stage/status change, schedule, manual…), conditions/branches/delays, and actions (send email/text*/drip, tags, notes, status/stage, assign agent, create task, Slack notify, property recommendation…). |
| **Campaigns (Marketing)** | Bulk email sends (with live property cards), tracked in Reporting. |
| **Templates** | Reusable email/text/script/voicemail templates **+ Drip Campaigns** (multi-email sequences; e.g. "The Long Game" 31-email buyer nurture). Drips send at a random time in a set window, skip US federal holidays, and roll to the next day if enrolled after the window. |
| **Social Media / Blog Posts** | Content planning + a blog tracker that auto-flips scheduled → posted when the date arrives. |
| **Vendors / Partners** | Directory with an AI "recommend a vendor/partner" email builder. |
| **Reporting** | SendGrid engagement per campaign/email (opens/clicks/bounces/unsubscribes) with drill-downs to who did what. |
| **Updates** | Auto-generated changelog of Hub development (pulls from git activity). |
| **Settings** | Email signature, "From" name, account info, Business Registration (Twilio A2P), and the Inbox email-connection manager (mailboxes). |
| **Calendar** | Google-Calendar-synced month view. |

*\*Text actions are staged for Twilio.*

---

## 8. Automation & scheduling (background jobs)

Driven by an in-process scheduler:

- **Sierra incremental sync** — every 60 min (was 10 min; slowed to protect the save path) + a boot sync. Plus on-demand full/status/date-scoped syncs.
- **Automation + Drip engines** — tick every 60s (enroll → condition/branch/delay → action, with idempotency + retries). Both skip US federal holidays for messaging.
- **Gmail inbox poll** — every ~60s (both mailboxes).
- **Google Calendar sync** — every 5 min.
- **TC daily digest** — 9 AM + 1 PM CT.
- **Slack deadline / walkthrough / task reminders** — checked each minute, fire at set times.
- **Backups** — nightly email + pre-boot snapshots.
- **FUB enrichment syncs** (score/budget/viewed-cities) — periodic.

All times are **America/Chicago (Central)**.

---

## 9. Mobile / PWA

- Fully **responsive** across phones (320–430px), tablets, and desktop (site-wide responsive layer; Inbox/Clients/Settings reworked for mobile; safe-area/notch support).
- **Installable PWA:** proper square icons (192/512 + maskable + Apple touch), a valid manifest (Chrome parses it with zero errors), a safe service worker (API always live, app shell cached for speed/offline), and an in-app **Install App** button (native prompt on Android/Chrome; Add-to-Home-Screen steps on iOS).
- Installs full-screen with the gold MST logo icon. Not a Play Store / App Store native app (that would be the optional Capacitor path — not built).

---

## 10. Notable engineering decisions & known constraints

- **Hub DB is the master.** Never re-sync transactions/pre-listings from any spreadsheet; those endpoints are disabled (410).
- **Sierra API limits:** Cloudflare-blocks non-server IPs; no webhooks on this account; **exposes no email/text/call history** (only leads/notes/listings + a `textOptOut` flag). Its search index also lags its UI, so freshly-imported leads can take an hour+ to appear via the API.
- **FUB is the source for texts/calls** since Sierra has none.
- **Single-instance today:** one Render web service + one sql.js file. A deploy briefly restarts the app. Horizontal scaling / zero-downtime would require moving to managed Postgres.
- **Service worker caching** means a new deploy can show the previous version for one load before refreshing.
- **Guardrails baked in:** no em dashes in any generated writing; block sends to `@notvalidemail.com`; moving a lead to Junk auto-removes it from active drips/automations; opted-out contacts are never emailed.

---

## 11. Environment variables (secrets)

Held on Render, never in code:

`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `SIERRA_API_KEY`, `FUB_API_KEY`, `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_REPLY_TO`, `GOOGLE_CALENDAR_ICAL_URL`, `SLACK_WEBHOOK_URL`, `TEAM_PASSWORD`, `TOKEN_SECRET`, `HUB_BASE_URL`, `DB_DIR`, `PORT`, plus notification recipients (`BACKUP_RECIPIENTS`, `TASK_NOTIFY_RECIPIENTS`, `TASK_REMINDER_MATT`, `TASK_REMINDER_LEO`, `TC_DIGEST_RECIPIENTS`, `TEAM_CLOSING_INVITE_RECIPIENTS`) and closer details (`CLOSER_*`). App-password mailboxes and the Slack webhook can also be stored in `app_settings`.

---

## 12. Repository layout (high level)

```
realestate-hub/
├─ index.html                 # app shell + PWA meta + viewport
├─ public/                    # manifest.json, sw.js, icons, logos, changelog.json
├─ src/
│  ├─ App.jsx                 # shell, nav, theme, PWA install button
│  ├─ main.jsx                # React mount + service-worker registration
│  ├─ pages/                  # Dashboard, Transactions, Clients, Inbox, Tasks, … (19)
│  ├─ components/             # Modal, RichTextEditor, EmailToolbar, AutomationBuilder, DripCampaigns, …
│  └─ styles/app.css          # global + responsive layer
└─ server/
   ├─ index.js                # Express app, route mounts, scheduler start, PWA/SPA serving
   ├─ database.js             # sql.js init, schema, atomic save, backup/restore
   ├─ scheduler.js            # all timed jobs
   ├─ sierra-helper.js, fub-helper.js, gmail-inbox.js
   └─ routes/                 # clients, transactions, tasks, inbox, followup, email,
                              #   automations, drips, sierra, reporting, blog-posts, …
```

---

*This manifest reflects the system as of 2026-08-07. The Hub is under active development; the Updates tab in the app tracks changes over time.*
