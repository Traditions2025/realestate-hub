# PostgreSQL Migration Plan (Planning Only — Do Not Execute)

**Status:** Reference plan. HUB runs on `better-sqlite3` today and it is healthy at current
scale (~40 MB, single Render node, ~45k clients). **Do not migrate now.** This documents
what a move to PostgreSQL would take, so the decision is informed rather than reactive.

## When migration is actually warranted
- Multiple app instances need to share one database (horizontal scale / zero-downtime deploys).
- Concurrent write contention becomes real (SQLite serializes writers).
- DB size / query complexity outgrows a single file, or managed backups/PITR are required.

None of these are true yet. SQLite + the persistent disk + verified backups is the right tool now.

---

## The core challenge: synchronous API
`better-sqlite3` is **synchronous** (`db.get/all/run` return immediately). There are **200+
call sites** across `server/**` that rely on this. `node-postgres` (pg) is **asynchronous**.
This is the single biggest cost of migration. Three viable strategies:

1. **Full async rewrite (cleanest, largest):** make every DB call `await`. Touches nearly
   every route + the AI stack + scheduler. High risk without strong tests.
2. **Data-access layer (recommended if we migrate):** introduce `server/db/index.js` exposing
   `get/all/run` plus `getAsync/allAsync/runAsync`, migrate call sites incrementally behind it,
   and only then swap the driver. Lets us move in slices, not a big bang.
3. **Embedded Postgres (PGlite) or keep-sync bridge:** generally not worth it; skip.

Recommendation: strategy **2** — build the abstraction first (even while staying on SQLite),
which also makes the eventual driver swap low-risk and reversible.

---

## SQLite-specific SQL to translate
Found across the schema and queries:

| SQLite | PostgreSQL |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT GENERATED ALWAYS AS IDENTITY` (or `BIGSERIAL`) |
| `datetime('now')`, `datetime('now','-1 day')` | `now()`, `now() - interval '1 day'` |
| `DEFAULT (datetime('now'))` | `DEFAULT now()` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `ON CONFLICT(col) DO UPDATE SET x=excluded.x` | same syntax; needs a real UNIQUE constraint |
| Boolean stored as `INTEGER 0/1` | `boolean` (or keep `smallint` to minimize churn) |
| JSON stored as `TEXT` (`JSON.stringify/parse`) | `jsonb` (optional; TEXT still works) |
| `lower()`, `LIKE`, `COALESCE` | compatible |
| `PRAGMA integrity_check / quick_check / journal_mode` | no equivalent — replace with pg health checks (`pg_database_size`, `pg_stat_activity`) |
| `db._raw.exec('BEGIN'/'COMMIT')` bulk mode | `BEGIN/COMMIT` via a pooled client/transaction |
| Timestamps compared as ISO strings | use `timestamptz` columns + proper comparisons |

**Timestamp caveat:** many rows store `nowIso()` (ISO-8601 text) and are compared
lexicographically. On Postgres these should become `timestamptz`; any string-compare logic
(e.g. dedup windows, `occurred_at >= ?`) must be reviewed during the port.

---

## Schema
~70 tables (see `server/database.js`). All use `CREATE TABLE IF NOT EXISTS` + the `_migrations`
ledger + guarded `ALTER TABLE ADD COLUMN`. Categories: CRM (`clients`, `transactions`,
`listings`…), comms (`communications`, `text_campaigns`, `scheduled_texts`…), AI ISA
(`ai_lead_state`, `lead_intelligence`, `ai_actions`, `ai_scheduled_actions`…), automations/drips,
accounts/audit (`users`, `user_sessions`, `audit_log`), ops (`failed_jobs`, `sierra_sync_log`).

**Foreign keys:** the SQLite schema is largely FK-light (relationships by `client_id` without
enforced constraints). A Postgres port is the moment to *optionally* add real FKs + `ON DELETE`
rules — but that is a data-cleanliness project of its own; keep it out of the first cut.

**Indexes:** port existing indexes (`idx_audit_*`, `idx_failed_state`, etc.) and add the
evidence-based ones from the Phase 20 performance audit rather than guessing.

---

## Migration path (when the time comes)
1. **Abstraction layer** (strategy 2) merged while still on SQLite; tests green.
2. **Schema DDL** generated for Postgres (translate the table map above); provision a managed
   Postgres (Render/Neon/Supabase) with PITR.
3. **One-time data copy:** export each SQLite table → load into Postgres (script that streams
   rows, converts booleans/timestamps/JSON). Verify row counts + spot-check per table.
4. **Dual-read validation:** point a staging instance at Postgres, run the app + test suite +
   a shadow period; compare against SQLite.
5. **Cutover:** brief maintenance window — final delta copy, flip the driver env, deploy, verify.
6. **Rollback:** keep SQLite as the source of truth until cutover is confirmed; the flip is a
   single env/driver change, so rollback = flip back + restore the last SQLite backup.

**Downtime:** a few minutes at cutover (final delta + deploy). No downtime before that.

---

## Health-check parity
Today `getDbHealth()` uses `PRAGMA quick_check` + file size. On Postgres, replace with
`SELECT pg_database_size(...)`, a trivial `SELECT 1` liveness probe, connection/pool stats,
and long-running-query checks from `pg_stat_activity`. The admin System Health panel stays the
same shape; only the server-side source changes.

---

## Bottom line
Migration is a **strategy-2-first**, multi-step project, not a swap. The highest-value
preparatory step (do this *only if/when* scale demands it) is the data-access abstraction — it
de-risks everything downstream and is reversible. Until then, SQLite with verified backups is
the correct, lower-risk choice.
