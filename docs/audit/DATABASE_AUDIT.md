# Database audit

Scope: migrations `0001` → `0032`, the migration runner, tenancy context,
automation execution tables, and the hot read paths.

---

## Migration mechanics

| Property | Status |
| --- | --- |
| Forward-only | yes — no down migrations, by design |
| Per-file transaction | yes — `BEGIN` / `COMMIT` per file, `ROLLBACK` on failure |
| Checksum recorded | yes — SHA-256 of the file, in `schema_migrations` |
| Edited-after-apply detection | yes — a changed checksum aborts the run with both values |
| Applied as | the migration role (owner), never the runtime role |
| Ordering | filename sort |

**Proven by execution:**

- An empty database migrates cleanly to `0032` — every integration run does
  this, and `tests/integration/migrate.test.ts` asserts the exact applied list
  and the exact resulting 89-table set.
- A failing migration rolls back and records nothing —
  `migrate.test.ts` drives that with a deliberately broken directory.
- Re-running is a no-op; a tampered file aborts.
- An upgrade from a realistic previous schema is exercised on every run: the
  shared test database is migrated once and then advanced as new files land.

### D-1 · No advisory lock around the migration run — OPEN, low

Two migration processes starting at once — a Railway redeploy racing a retry —
would both read `schema_migrations`, both see a file as pending, and both try to
apply it. The primary key on `name` means the second **fails loudly** rather
than corrupting anything, so this is a noisy failure and not a data risk.

`SELECT pg_advisory_lock(...)` around the loop would turn it into a wait. Worth
doing; not a release blocker.

---

## Tenant isolation

The strongest part of this schema.

- `app_current_tenant()` reads `convo.tenant_id` and returns NULL when unset.
  `tenant_id = NULL` is NULL, not true, so **the default is DENY**.
- Every tenant-owned table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so
  the table owner is subject to the policy too — a future owner-role write path
  cannot quietly bypass it.
- Every policy declares both `USING` and `WITH CHECK`, so a row cannot be
  written into another tenant any more than it can be read from one.
- `withTenant` issues `SET LOCAL` and then **reads the setting back** and
  asserts the database agrees. That turns "we set it" into "it took effect", and
  `SET LOCAL` means a pooled connection cannot carry it into the next checkout.
- The runtime role holds no `BYPASSRLS`, owns nothing, and has no `CREATE` on
  the schema.

**The two carve-outs** are the only paths that resolve a tenant without a
membership, and both are narrow by construction: the setting is
transaction-local and is matched against **one** column — the invitation token
fingerprint, or the channel asset fingerprint a webhook signature has already
proved. Not "all invitations while a flag is set". After resolution the
transaction continues under the ordinary tenant context.

**Global, deliberately un-RLS'd tables:** `users`, `permissions`,
`installations`, `user_sessions`, `auth_rate_limits`,
`password_recovery_challenges`, `channel_apps`, `schema_migrations`, and
`email_deliveries` (new). Each is installation infrastructure that no
tenant-scoped API reads. Isolation for these is structural — there is no
controller over them — rather than policy-based. Password recovery genuinely
cannot carry a tenant context: the person is not signed in and may hold
memberships in several companies.

**Proven by execution:** `tests/integration/tenant-isolation.test.ts`; and the
restore drill re-proves it on a *restored* copy, by querying as the runtime role
with a real tenant context, with a foreign one, and with none.

---

## Constraint defects found

### D-2 · `invitation_scopes` made tenant-wide invitations impossible — FIXED

Migration 0008 declared:

```sql
scope_id uuid,                                              -- nullable
PRIMARY KEY (tenant_id, invitation_id, scope_type, scope_id)
CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR ...)
```

A PRIMARY KEY makes every one of its columns `NOT NULL` whatever the column
declaration says. The CHECK therefore demanded a NULL the key forbade, and
**every tenant-wide invitation failed with a not-null violation**, surfacing as
HTTP 500. That is the ordinary case: an administrator inviting a colleague to
the whole company. Broken since 0008, invisible because no test covered that
scope.

`membership_scopes`, in the same migration set, gets it right with a surrogate
key and a genuinely nullable `scope_id`.

**Fixed** by migration `0031`: drop the key, drop the residual `NOT NULL`
(dropping a PK does **not** clear it — that caught the first attempt), and
re-express uniqueness as a unique index with `NULLS NOT DISTINCT`.

**Proven by:** `tests/integration/api-email.test.ts`, which creates tenant-wide
invitations throughout, and the restore drill, which seeds one.

### D-3 · Nullable-unique handling elsewhere — CORRECT

The same class of bug was already found and fixed by the automation work:
migration `0029` replaces `automation_recipients`' unique constraint with a
`NULLS NOT DISTINCT` index, because SQL treats NULLs as distinct and a recipient
with no chosen identity could otherwise be admitted twice into one run.

`inbound_events` handles it a third correct way, with
`coalesce(provider_message_id, '')` inside the unique index.

Three tables, three correct treatments. Only `invitation_scopes` was wrong.

---

## Concurrency and queues

Every queue in this product is a PostgreSQL table claimed under a lease with
`FOR UPDATE SKIP LOCKED`. No broker is required for any of it, and the audit
found no reason to introduce one.

| Concern | Mechanism | Verdict |
| --- | --- | --- |
| Two workers claiming one row | `SKIP LOCKED` + lease column | correct |
| Worker dies mid-claim | lease expires, row is reclaimed | correct |
| Two messages per conversation in flight | three layers: `DISTINCT ON` within the batch, `NOT EXISTS` against committed leases, and `pg_try_advisory_xact_lock` for the gap between them where a lease has not committed yet | correct, and the advisory lock is the part most implementations miss |
| Stale worker overwriting a newer decision | `dispatch_version` fence on every settle; a lost fence records the attempt as evidence and applies nothing | correct |
| Duplicate inbound events | `ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`, and duplicates are **counted** so redelivery is visible | correct |
| Duplicate outbound effects | attempt row committed **before** the network call; a crash after it yields `outcome_unknown`, never a resend | correct (ADR-0006) |
| Campaign recipient duplication | `campaign_stop_version` matched against the execution's, plus recipient state | correct |
| Automation run duplication | `UNIQUE (tenant_id, automation_id, idempotency_key)` + `ON CONFLICT DO NOTHING` | correct |
| Email duplication | `UNIQUE (kind, idempotency_key)` + provider `Idempotency-Key` | correct |
| Deferred constraints | used for the last-Owner trigger and in the restore | correct |

### D-4 · Tables with no retention policy — OPEN, medium

Several tables grow without bound and nothing prunes them:

| Table | Grows with | Risk |
| --- | --- | --- |
| `webhook_receipts` | **every** delivery, including refused ones | unbounded, and writable by an unauthenticated caller (see `SECURITY_AUDIT.md`, S-6) |
| `channel_events` | every inbound event, payload retained | largest table over time |
| `inbound_events` | every normalized event | largest table over time |
| `realtime_events` | every realtime fact | high churn |
| `email_deliveries` | every email; payload is scrubbed but the row stays | low volume |
| `admin_audit_events`, `campaign_audit`, `metadata_audit` | audit, intentionally retained | needs an archive plan, not deletion |
| `idempotency_records`, `auth_rate_limits` | have `expires_at` but **no sweeper** | grows despite the column |

Nothing here breaks at MVP volume. All of it breaks eventually, and the two with
an `expires_at` column and no process to honour it are the most obviously
unfinished.

**To close:** a retention sweep on the report worker's tick, and a documented
retention period per table (ADR-0012 covers media; this is the rest).

### D-5 · `recoverOrphanedAttempts` is unbounded — FIXED

Recovery now orders by oldest attempt, claims at most 100 rows with
`FOR UPDATE OF a SKIP LOCKED`, and leaves the remainder claimable by the next
tick. An integration test creates two orphaned attempts, recovers with a limit
of one, proves exactly one remains pending, then reclaims the second. Recovery
still never resends an unknown outcome.

## Retention and growth decision

Staging measurements after the operator/load probes show the high-growth tables
at 0–6 rows and 16–80 KiB each. For a conservative 25-operator pilot, assuming
500 conversations/day, 20 events/conversation, two webhook deliveries/event,
and 2 KiB of indexed storage per retained event, event evidence grows at roughly
40 MiB/day (about 14.6 GiB/year). Audit, provider receipt, email, and automation
evidence is materially lower at that traffic.

No release-time deletion job was added because retention periods are a business
and compliance decision, and deleting append-only audit/provider evidence under
an invented policy is less safe than measured growth. Before 10 GiB or 90 days,
whichever arrives first, the owner must approve per-table retention. Any later
sweeper must use indexed timestamps, tenant-scoped batches of at most 1,000,
`SKIP LOCKED`, and must never delete active leases, unresolved provider outcomes,
consent/suppression evidence, or business audit records.

---

## Query plans at volume

`EXPLAIN (ANALYZE, BUFFERS)` against 10,000 conversations and 10,000 contacts,
reproducible with `npx vitest run --project load tests/load/explain.test.ts`.

| Path | Plan | Time |
| --- | --- | --- |
| conversation list, recent first | index scan, `conversations` | sub-ms |
| contact search, infix LIKE | bitmap index scan on the tenant index, filter in memory, top-N heapsort | **1.0 ms** |
| contact list, no search term | same shape | sub-ms |
| message timeline | index scan on `inbound_events_conversation_idx` | sub-ms |

**No missing index was found.** The one endpoint that measured slow —
contact search at 61 ms — was not slow because of its query plan, and the index
that "obviously" fixed it changed p50 by under 3% and was removed. The cost was
400 round trips from an N+1 in `ContactService.list`, now batched. The full
story is in `LOAD_TEST_REPORT.md`, and it is the reason this audit adds **no**
indexes: every candidate was measured and none earned its write cost.

The existing indexes are well chosen, and several are partial in exactly the
right way — `outbox` on the dispatchable subset, `conversations_unassigned_idx`
on open-and-unassigned, `automations_due_idx` on active-and-scheduled,
`email_deliveries_claim_idx` on pending only. Those keep each index the size of
the working set rather than the size of the history.

---

## Backup and restore

`pnpm test:recovery` — 13 tests, passing. It proves schema checksums match, all
tables' row counts match, RLS is still enabled/forced/policied, tenant
isolation still works on the restored copy, foreign keys are still enforced, and
the application boots against it and serves authenticated reads.

The Railway staging drill also exercised real `pg_dump`/`pg_restore`: 32
migrations and the seeded tenant were verified on a disposable restored
database; dump took under one second and restore took two seconds. Production
PITR, daily/weekly schedules and a named release recovery point are now active;
the native point booted successfully and the original production volume was
reattached. Full detail, including the restore command's volume-swap behavior,
is in `docs/runbooks/DATABASE_RECOVERY.md`.

---

## Summary

| Severity | Count | |
| --- | --- | --- |
| Critical | 0 | |
| High | 1 | D-2, fixed |
| Medium | 1 | D-4, explicitly deferred with threshold |
| Low | 1 | D-1, open |

The schema is strong. Tenant isolation, the dispatch gate, the fencing and the
dedupe keys are all correct, and several are more careful than typical. The
defects found were one contradiction between a key and a check that had never
been exercised, and a set of tables that nothing prunes.
