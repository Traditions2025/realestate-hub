# HUB Implementation Roadmap

Prioritized, dependency-ordered plan derived from `HUB-ROADMAP-AUDIT.md`. Each item is sized
to be shipped **incrementally** (migration → code → tests → build → docs), preserving the
manual-first AI philosophy, the centralized communication policy, and backwards compatibility.

Priority bands: **P0** security/data integrity · **P1** core CRM/AI production readiness ·
**P2** intelligence/reporting/mobile · **P3** advanced AI/Voice · **P4** long-term.

---

## P0 — Security / Data Integrity

### P0-1 · Individual accounts + roles + audit log (Phase 1, foundation) — **START HERE**
- **Why it matters:** replaces the single shared password with attributable identities and least-privilege; unblocks the audit log every sensitive action needs.
- **Current state:** ⛔ shared `TEAM_PASSWORD` + stateless team token; no users/roles/audit.
- **Required work (incremental):**
  1. *(this increment)* Migrations for `users`, `audit_log`, `user_sessions`; scrypt password hashing (node:crypto, no new deps); `rbac.js` (ROLES→permissions, `can(role, perm)`); audit helper; **backwards-compatible** login (shared password still works, issues an owner token; add per-user email+password login); token carries `uid`+`role`; `requireAuth` attaches `req.user`; owner-only `/api/users` CRUD; seed initial OWNER. Tests + docs.
  2. *(next)* Per-route permission enforcement via `requirePermission(perm)` middleware, applied progressively (read first, then destructive/bulk/AI/settings).
  3. *(next)* Session revocation UI (logout, revoke-all, login history).
  4. *(next)* Optional TOTP 2FA + recovery codes.
- **Dependencies:** none (foundation). Audit log is a prerequisite for later phases.
- **Risk:** High (touches auth) → mitigated by keeping the shared-password path working and NOT gating routes in increment 1.
- **Testing:** hash/verify round-trip; `can()` matrix; legacy token still authorizes; per-user token carries role; audit rows written on login.

### P0-2 · Unified automated-communication collision guard (Phase 17) — ✅ DONE
- **Why:** prevents AI + automation + bulk from texting the same lead at once.
- **Delivered:** `policy.canAutomatedSend(client, { source, dedupMinutes, respectQuietHours })` layering on `canSendSms` and blocking: hard compliance (STOP/DNT/DNC), human takeover/handoff, an active AI conversation or pending AI action (unless source==='ai'), an active human 1:1, a duplicate within the dedup window, and quiet hours. Wired into the **automation `send_text`** action, **bulk-text** (per-recipient, reported as `excluded.active_conversation`), and a light variant into **scheduled 1:1 texts**. Drips are email-only, so not a texting-collision path. 8 tests in `test/collision-guard.test.mjs`.

### P0-3 · Failure visibility + backup verification (Phase 16 + Phase 2) — ✅ DONE
- **Why:** stop silently losing failed sends/actions; guarantee a *usable* backup.
- **Delivered:** `failed_jobs` table + `server/failures.js` (`recordFailure` dedups by kind+ref and bumps `retry_count`; `listFailures`/`failureCounts`/`resolveFailure`). Wired into the previously-silent bulk-text and scheduled-text failure paths, and into the daily backup. **Backup verification:** `verifyBackupFile()` opens each backup read-only, runs `PRAGMA integrity_check`, and confirms core data is queryable ("job ran" ≠ "usable backup"); `getBackupHealth()` reports newest/age/verified/stale; a failed/unverified backup records a failure. Admin **System Health** tab surfaces backup health + open failures with resolve. `/api/admin/health|failures`. 7 tests. *(Deliberately visibility-first — no auto-retry of SMS sends, which could double-text; safe retry can be layered on later.)*

### P0-4 · DB health diagnostics + Postgres plan doc (Phase 2) — ✅ DONE
- **Delivered:** `getDbHealth()` + `GET /api/admin/db-health` (size, `PRAGMA quick_check` integrity, journal mode, page/freelist counts, table + migration counts, client count, 24h scheduler sync errors) surfaced as the **Database** card in the Admin System Health tab. `POSTGRES-MIGRATION-PLAN.md` authored (planning only — the sync-API rewrite is the core cost; recommends a data-access abstraction first; no migration executed). 1 test.

**→ P0 band (security / data integrity) is COMPLETE.** Next work moves to **P1** (core CRM / AI production readiness): P1-1 model-scored AI regression suite, P1-2 conversation classifier + structured memory, P1-3 behavioral events + intent decay, P1-4 AI Opportunities 2.0, P1-5 Smart Audiences engine, P1-6 lead routing. Also available as a small follow-on: rolling `requirePermission` enforcement across existing routes (P0-1 increment 2) and the Owner/Admin split.

---

## P1 — Core CRM / AI production readiness

### P1-1 · Model-scored AI regression suite (Phase 7)
- 50 buyer + 50 seller scenarios, 0–2 rubric, auto-fail on hallucination/steering/ignored-STOP, saved runs, prompt/model-version diff. **Gate before broad Autopilot.** Dependencies: AI stack. Risk: Low (offline eval). Testing: the harness IS the test.

### P1-2 · Conversation classifier + structured memory fields (Phase 6)
- Add a classifier stage writing `conversation_type` (buyer/seller enums) + per-field memory `source/confidence/timestamp`. Extend `lead_intelligence`. Dependencies: prompts/orchestrator. Risk: Medium (prompt behavior) → keep single model call, add a light classify pass. Testing: classifier scenarios + regression suite.

### P1-3 · Behavioral events + intent decay (Phase 8)
- Normalized `behavioral_events` (typed, weighted); intent **decay** over time with `current/peak/previous/delta`; feed audiences + opportunities + NBA. Dependencies: fub/tracking. Risk: Medium. Testing: decay math; peak retention; event weighting.

### P1-4 · AI Opportunities 2.0 (Phase 5)
- Morning-intelligence roll-up + prioritized action queue with evidence + recommended action + suggested message. Dependencies: P1-3 (behavior/intent). Risk: Low-Medium.

### P1-5 · Smart Audiences behavioral engine (Phase 3)
- Extend `client_lists` into an AND/OR condition engine adding intent, last-human-contact, repeat-view, Realist-score, AI-managed, handoff-pending, overdue-next-action, with count preview. **Segmentation only — never auto-sends.** Dependencies: P1-3. Risk: Medium (query perf → indexes).

### P1-6 · Advanced lead routing (Phase 4)
- `routing_rules` + engine (round-robin/weighted/geo/price/source/availability) + `routing_history`; manual reassignment is sticky. Dependencies: P0-1 (users/roles). Risk: Medium.

---

## P2 — Intelligence / reporting / mobile

- **P2-1 Conversion attribution + AI ROI funnel (Phase 9)** — funnel + source/agent/AI-vs-human/AI-managed breakdowns; correlation-not-causation framing. Dep: P1-3/P1-4.
- **P2-2 Unified contact timeline (Phase 18)** — merge comms + notes + tasks + status/tags + AI actions + assignments + handoffs + transaction events into one filterable stream. Dep: P0-1 audit (for AI/assignment events).
- **P2-3 Push notifications + mobile quick actions (Phase 10)** — web push for handoffs/new-lead/inbound-text/missed-call/showing/task/transaction; notification quick actions. Dep: P2-4.
- **P2-4 Notification center (Phase 14)** — persistent `notifications` history. Dep: P0-1.
- **P2-5 Universal search + safe dedupe/merge (Phase 14)** — cross-entity search; merge that never deletes history. Dep: none.
- **P2-6 System-health dashboard (Phase 15)** — all integrations + backups + queues in one admin view. Dep: P0-3/P0-4.
- **P2-7 Data export & recovery (Phase 19)** — owner export + safe backup download, no secrets. Dep: P0-1.

---

## P3 — Advanced AI / Voice

- **P3-1 Controlled database reactivation engine (Phase 11)** — eligibility scoring + tiny test groups + measurement. Dep: P0-2, P1-3, P1-5. Manual-first.
- **P3-2 AI Voice (Phase 12)** — only after AI Text passes P1-1 thresholds; manual-enable → controlled test → measured expansion. Preserve deferral.
- **P3-3 Specialized AI agents (Phase 13)** — buyer/seller/reactivation/transaction/marketing/listing sub-agents sharing one identity/policy/memory/audit/handoff foundation. Dep: P1-1, P1-2.

---

## P4 — Long-term enhancements

- **P4-1 Postgres migration execution (Phase 2)** — only after P0-4 plan + demand. High risk; staged.
- **P4-2 Performance/index audit at scale (Phase 20)** — evidence-based indexing for timeline/search/audience/aggregation.
- **P4-3 Saved views everywhere; configurable per-permission roles (Phase 1 follow-on).**

---

## Explicitly NOT prioritized (per roadmap)
IDX engine, MLS database, generic website builder, large app marketplace, and AI features not tied to measurable workflow/conversion. Sierra/FUB remain the IDX/enrichment sources.

---

## Execution rule
Do the P0 items in order; never skip an unresolved P0 for a lower band unless a documented
technical dependency requires it. Each item ships complete: migration → code → tests →
`npm test` + `npm run build` green → `HUB-SYSTEM-OVERVIEW.md` + changelog updated.

**Next action:** implement **P0-1 increment 1** (accounts + RBAC + audit-log foundation,
backwards-compatible), then proceed.
