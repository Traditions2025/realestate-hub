# HUB Roadmap Audit

Repository-level audit of the Matt Smith Team HUB against the Master Development Roadmap.
Verified against the live codebase on 2026-08-21 (schema in `server/database.js`, routes in
`server/routes/*`, AI in `server/ai-followup/*`, scheduler, auth, and the React pages).

**Legend:** ✅ COMPLETE · 🟡 PARTIAL · ⛔ MISSING · 🔎 NEEDS REVIEW

| Phase | Area | Status |
|---|---|---|
| 0 | Production safety audit (auth) | 🟡 PARTIAL (audited below) |
| 1 | Individual user accounts + RBAC | ⛔ MISSING |
| 2 | DB resilience + Postgres readiness | 🟡 PARTIAL |
| 3 | Smart Audiences | 🟡 PARTIAL |
| 4 | Advanced lead routing | ⛔ MISSING (basic assignment exists) |
| 5 | AI Opportunities 2.0 | 🟡 PARTIAL |
| 6 | Buyer + Seller AI training system | 🟡 PARTIAL |
| 7 | AI regression test suite | 🟡 PARTIAL |
| 8 | Behavioral intelligence | 🟡 PARTIAL |
| 9 | Conversion attribution | 🟡 PARTIAL |
| 10 | Mobile + push | 🟡 PARTIAL |
| 11 | Database reactivation engine | 🟡 PARTIAL (drips exist) |
| 12 | AI Voice | ⛔ MISSING (deferred by design) |
| 13 | Specialized AI agents | ⛔ MISSING |
| 14 | Operational polish | 🟡 PARTIAL |
| 15 | Observability | 🟡 PARTIAL |
| 16 | Failure queues | ⛔ MISSING |
| 17 | Automation engine hardening | 🟡 PARTIAL |
| 18 | Contact timeline | 🟡 PARTIAL |
| 19 | Data export & recovery | 🟡 PARTIAL |
| 20 | Performance | 🟡 PARTIAL |

---

## Phase 0 — Production Safety Audit (auth) — 🟡 PARTIAL

**Current implementation (`server/routes/auth.js`, verified):**
- Single shared `TEAM_PASSWORD` (env, default `mattsmithteam2026`).
- Stateless **HMAC-signed token**: `base64url(payload).HMAC-SHA256(payload, TOKEN_SECRET)`. Payload = `{t:'team', iat, exp}`. **30-day expiry.**
- Sent as `x-auth-token` header; `requireAuth` verifies signature + expiry on every `/api/*`.
- Public exceptions (correct): `/api/auth/login|verify`, `/api/db-status`, `/api/health`, `/api/sierra/webhook`, `/api/inbox/parse-inbound|twilio-inbound|twilio-status`, `/api/voice/*` (Twilio-signed), `/api/social-media/img/*`, n8n queue/result, `/api/track/beacon`, `/track.js`, and query-token media/recording/stream proxies.

**Findings (gaps):**
- **No individual identity** — every user is the same "team" principal; actions are not attributable.
- **No token revocation** — a signed token is valid until it expires; no server-side session store, no logout-invalidates-token, no "revoke all sessions."
- **No login logging / failed-login tracking / lockout / rate-limiting** on `/api/auth/login`.
- **Password**: single shared secret in env, compared in plaintext (`===`). No hashing (there's only one password, but there's no per-user hashing infra).
- **CSRF**: low risk — token is a custom header (not a cookie), so classic CSRF doesn't apply; but there's no same-site/Origin check on state-changing routes.
- **XSS**: React escapes by default; the Inbox renders inbound email HTML inside a **sandboxed iframe** (`sandbox="allow-same-origin"`), which is reasonable. Template/AI content is rendered as text. No obvious stored-XSS sink found, but no CSP header is set.
- **Secret handling**: secrets live in Render env + `app_settings` (e.g., Twilio/Gmail app passwords). `mailboxesPublic()` masks passwords; the new `/api/comms/twilio-reputation` and `/api/inbox/contact-emails` are auth-gated and never return secrets. No secret is exposed to the client bundle.
- **Authorization**: binary (authed or not). No per-action authorization — any logged-in session can do anything (bulk SMS, delete, AI autopilot, settings).

**Risk:** Medium-High. The system is a single-tenant shared login; the main exposures are non-attributable actions, no revocation, and no least-privilege. Acceptable for a tiny trusted team today, but Phase 1 is the correct fix.

---

## Phase 1 — Individual user accounts + RBAC — ⛔ MISSING

- No `users` table, no `password_hash`, no roles, no `can()` helper, no `audit_log`, no 2FA, no sessions.
- `team_agents` exists but is a **directory** (name/phone/title for texting + assignment), **not** auth accounts.
- **This is the highest-priority unresolved item.** See implementation roadmap P0.

---

## Phase 2 — DB resilience + Postgres readiness — 🟡 PARTIAL

- **Present:** `better-sqlite3` single-file DB at `DB_DIR`; atomic `saveDb()`; bulk-mode deferral; idempotent `_migrations`; 5-layer backup strategy (`server/backup.js`) emailing `BACKUP_RECIPIENTS`; `sierra_sync_log`.
- **Missing:** any DB abstraction / Postgres path (`POSTGRES-MIGRATION-PLAN.md` does not exist); SQLite-specific SQL is used directly (`datetime('now',...)`, `ON CONFLICT`, `better-sqlite3` sync API, JSON stored as TEXT). No DB health diagnostics surface (size, backup age, integrity check, lock errors). **Backup *verification*** (readable/recent/alert-on-fail) is not implemented — only "the job ran."

---

## Phase 3 — Smart Audiences — 🟡 PARTIAL

- **Present:** `client_lists` (`server/routes/lists.js`) = saved **filter-based** lists that auto-update against CRM fields (status/tags/zips/cities/sources/score/visits/activity windows), plus rich advanced filters on the Clients page and quick presets (Hot Leads, Re-engagement 90d+, High Engagement 5+ visits, etc.).
- **Gap vs roadmap:** conditions are CRM-field filters, not the full **behavioral + AI-intelligence** engine (intent thresholds, last-human-contact windows, repeat-property-view, Realist-sell-score + no-active-listing, AI-handoff-pending, overdue-next-action). No AND/OR nested condition builder, no count-preview on a composed audience. Foundation is solid; the engine needs the behavioral/AI dimensions.

---

## Phase 4 — Advanced lead routing — ⛔ MISSING (basic assignment exists)

- **Present:** manual assignment (`/api/inbox/thread/:id/assign`, `agent_assigned` on clients, assignment filters in Inbox, `team_agents` directory).
- **Missing:** any **rules engine** — no round-robin / weighted / geographic / price-band / source-specialist / availability-aware routing, no routing-rule table, no routing-history/audit of assignment changes with rule+reason.

---

## Phase 5 — AI Opportunities 2.0 — 🟡 PARTIAL

- **Present:** `/ai-opportunities` page + `ai_handoffs` queue with intent score, reason, urgency, recommended_action, summary; acknowledge/resolve; `lead_intelligence.ai_summary`.
- **Gap:** it is essentially a **handoff list**. No "morning intelligence" roll-up (X leads rose in intent overnight, Y re-engaged, Z repeat-viewed), no unified prioritized action queue spanning intent-change + behavior + overdue follow-ups + transaction items, limited "evidence" surface. Explainability exists as `intent_reason_json` but isn't presented as the roadmap's factor list.

---

## Phase 6 — Buyer + Seller AI training system — 🟡 PARTIAL

- **Present (recently strengthened):** modular `server/ai-followup/*` (policy, state, intent, context, prompts, orchestrator, scheduler, handoff, memory, events, audit). Prompt now carries conversation-first REASONING, objection/SITUATION playbooks, ACCURACY (VERIFIED/INFERRED/UNKNOWN), Fair Housing, security. Structured memory via `applyMemory` + `lead_intelligence`. Intent is deterministic + AI-delta. "Most useful unanswered question" behavior is in the prompt. Handoff on threshold/explicit.
- **Gap vs training book pipeline:** no **explicit conversation-type classifier** stage (buyer/seller intents are not stored as a typed field), memory fields lack per-field source/confidence/timestamp structure, and generation is largely single-shot (not the discrete classify→extract→intent→NBA→generate→factuality→style pipeline). Buyer/seller structured-memory schemas are informal, not columns.

---

## Phase 7 — AI regression test suite — 🟡 PARTIAL

- **Present:** `test/hubai.test.mjs` (27) + `test/hubai-scenarios.test.mjs` (57) covering the **deterministic** safety layer: intent detection, literal + natural-language opt-out, exclusions, greeting/Central-time, prompt-content assertions. 84 tests pass.
- **Gap:** no **model-scored** 50-buyer / 50-seller scenario suite with the 0–2 rubric (relevance/naturalness/accuracy/concision/qualification/memory/intent/handoff/compliance/pressure), no auto-fail gates on hallucination/steering, no saved run history or prompt/model-version comparison.

---

## Phase 8 — Behavioral intelligence — 🟡 PARTIAL

- **Present:** `fub_activity`, `lead_activity`, Hub tracking pixel, FUB web-activity + Realist-score + budget syncs; `computeIntent` weights replies + recent activity + preapproval + timeframe.
- **Gap:** no **normalized behavioral-event model** (typed events: property_view/repeat_view/favorite/saved_search/return/price_change…), no weighting+**decay** (intent does not decay over time), no `peak_intent`/`previous_intent`/`intent_delta` history surfaced (there is `ai_intent_history` rows but no decay logic or peak tracking).

---

## Phase 9 — Conversion attribution — 🟡 PARTIAL

- **Present:** Reporting tab (texting/calls, campaigns, SendGrid engagement), AI analytics (actions, quality ratings), transactions pipeline.
- **Gap:** no **funnel** (Lead→Contacted→Responded→Conversation→Qualified→Handoff→Appointment→Client→UC→Closed) and no **attribution** breakdown by source/campaign/agent/AI-vs-human/AI-managed, no AI-ROI (managed→conversations→appointments→closings→GCI) comparison.

---

## Phase 10 — Mobile + push — 🟡 PARTIAL

- **Present:** installable PWA (this *is* the mobile app), mobile-responsive layer, Capacitor scaffolding, Slack alerts for deadlines.
- **Gap:** **no web push / native push** notifications for handoffs, new-lead, inbound text, missed call, showing requests, task/transaction alerts. No mobile quick-action surface (Call/Text/Take-over/Dismiss from a notification).

---

## Phase 11 — Database reactivation engine — 🟡 PARTIAL

- **Present:** drip campaigns (past-client, expired/FSBO, seller nurture), bulk text with STOP/DNC exclusion, AI enrollment.
- **Gap:** no dedicated **reactivation engine** with eligibility scoring (consent/opt-out/representation/recency/quality/behavior/homeownership/transaction suppression) + tiny controlled test-group workflow + measured response/opt-out/appointment/conversion.

---

## Phase 12 — AI Voice — ⛔ MISSING (intentionally deferred) — preserve decision

- Voice infra exists (browser softphone, voicemail, drop). AI Voice (ConversationRelay) not built and **should stay deferred** until AI Text hits quality thresholds. Correct per roadmap.

---

## Phase 13 — Specialized AI agents — ⛔ MISSING

- Single ISA today. No buyer/seller/reactivation/transaction/marketing/listing sub-agents sharing one foundation. Correctly gated behind "main ISA reliable first."

---

## Phase 14 — Operational polish — 🟡 PARTIAL

- **Present:** bulk actions (email/text/AI-send/power-dialer/drip/automation/type/refresh, with confirmations); saved lists; contact-cleanup tooling (VCF) exists as a batch process.
- **Missing:** **universal search** across entities; in-app **dedupe/safe-merge** UI; **notification center** (persistent notification history); saved *views* beyond client lists (transactions/tasks/reporting).

---

## Phase 15 — Observability — 🟡 PARTIAL

- **Present:** `/api/comms/health` (Twilio stack), `/api/comms/twilio-reputation` (new), `/api/db-status`, `/api/health`, `sierra_sync_log`, AI `/scheduler` + `/diagnostics`, crash logging (`recordCrash`).
- **Gap:** no single **system-health dashboard** covering all integrations (Sierra/FUB/Twilio/SendGrid/Gmail/Calendar/Slack/Anthropic/backups/AI-queue/scheduled-texts) with status/last-success/last-failure/next-run in one place.

---

## Phase 16 — Failure queues — ⛔ MISSING

- Failed SMS get a delivery status; `scheduled_texts` has states; AI actions are logged with status. But there is **no retry/dead-letter queue** model (retryable/permanent/retry_count/last_error/next_retry_at) and no admin visibility into failures for reprocessing.

---

## Phase 17 — Automation engine hardening — 🟡 PARTIAL

- **Present:** automations with `automation_enrollments/versions/executions/events`; drip engine; `canSendSms` centralizes per-lead compliance (STOP/DNT/status/quiet-hours/AI-force); human-takeover cancels pending AI.
- **Gap:** no single **`canAutomatedCommunicationSend(lead, channel, source, context)`** consulted by *every* automated path (drip + automation + bulk + AI) to prevent **collisions** (AI mid-conversation while a drip/automation/bulk also texts). Idempotency/trigger-dedup exists partially per-engine but isn't unified.

---

## Phase 18 — Contact timeline — 🟡 PARTIAL

- **Present (recently added):** client profile "Communication History" = texts + calls + voicemails + logged emails, with recordings/transcripts; plus Sierra activity, FUB activity, Hub tracking, email history, sequences.
- **Gap:** these are **separate sections**, not one **unified chronological timeline** merging comms + notes + tasks + status/tag changes + AI actions + assignments + handoffs + transaction events with type filtering.

---

## Phase 19 — Data export & recovery — 🟡 PARTIAL

- **Present:** scheduled DB backups; Sierra import/export helpers; per-client email history.
- **Missing:** an **Owner/Admin export** (contacts/transactions/comms-metadata/tasks/AI-intelligence/config) and a safe backup **download** in-app.

---

## Phase 20 — Performance — 🟡 PARTIAL

- **Present:** lazy-loaded page bundles, service-worker cache, count-only endpoints (no loading 45k rows), some indexes, mobile optimizations.
- **Gap:** no evidence-based index audit for timeline/search/audience/behavioral-aggregation queries at realistic (40k+ client) scale.

---

## Summary of true gaps (most impactful first)
1. **No individual accounts / RBAC / audit log** (Phase 1) — security + attribution foundation.
2. **No unified automated-communication collision guard** (Phase 17) — real risk of double-texting.
3. **No failure/retry visibility** (Phase 16) — silent loss of failed sends/actions.
4. **No backup verification** (Phase 2) — "job ran" ≠ "usable backup."
5. **Behavioral events + intent decay** (Phase 8) — intelligence accuracy.
6. **Smart Audiences behavioral engine, routing, funnel/attribution, push, timeline, observability dashboard, model-scored AI regression** — high-value product depth.
