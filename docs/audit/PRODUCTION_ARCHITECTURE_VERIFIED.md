# Production architecture, verified

Every arrow below was traced in source and, where marked, executed. Claims that
could not be executed are marked **UNVERIFIED** with the reason.

## Topology as deployed

```
                       ┌─────────────────────────────┐
  browser  ──https──▶  │ convo-client-demo  (PUBLIC) │
                       │ static files + /api proxy   │
                       └──────────────┬──────────────┘
                                      │ private network
                                      ▼
                       ┌─────────────────────────────┐
                       │ convo-api   role=api        │
                       └──────────────┬──────────────┘
                                      │
  Meta  ──https──▶  /api/v1/webhooks/meta/:id (same API process)
                                      │
                                      ▼
                       ┌─────────────────────────────┐
                       │ PostgreSQL  (private)       │
                       │ every queue is a table      │
                       └──────────────▲──────────────┘
                                      │
   worker-inbound · worker-interactive · worker-campaign
   worker-report  · worker-integration · worker-automation
```

`ingress` and `realtime` exist as roles in the artifact but are **not deployed
as separate services**; the `api` role serves both today. That is a scaling
decision, not a correctness one.

`worker-integration` and `worker-automation` are **new in this release** and
must be created before deploying it. See ADR-0018.

---

## Arrow by arrow

For each: who calls it, what authenticates it, what happens on timeout, on
duplicate delivery, and on a crash halfway through.

### Browser → web service → API

| | |
| --- | --- |
| Authentication | `convo_session` cookie, HttpOnly, `SameSite=Strict`, path `/api/v1`. Only an HMAC fingerprint is stored. |
| CSRF | double-submit; the `convo_csrf` cookie **and** the `x-csrf-token` header must both match the session's stored fingerprint. Required on every mutation. |
| Timeout | the proxy answers 502 `api_unavailable`; the SPA surfaces it. No retry — a retried mutation is a second mutation. |
| Duplicate | mutations that mint credentials require `Idempotency-Key`; a retry replays the first answer. |
| Crash halfway | request transaction rolls back. Nothing partially applied. |
| Durable before ack | yes — the response is written after `COMMIT`. |
| Tenant A → B | no. Every tenant-scoped route goes through `AuthorizationService.authorized`, which sets the RLS context; a wrong id returns no rows. |
| Source of truth | PostgreSQL. |
| Observed | one JSON log line per request: `request_id`, `route`, `status`, `duration_ms`. The same `request_id` is returned in `x-request-id`. |

**Verified by execution:** 545 integration tests including
`api-auth`, `api-authorization`, `tenant-isolation`, `api-contract`.

**Fixed this pass:** `trustProxy` was unset, so `request.ip` was the proxy for
every user and the login rate limiter was one shared bucket
(`SECURITY_AUDIT.md`, S-1).

### Meta → webhook ingress

The order **is** the design (ADR-0005), and it is this order:

1. read the **exact raw bytes** — a dedicated content-type parser keeps the
   buffer and hands the route no parsed body;
2. verify the HMAC and the replay window, before any parse, lookup or write;
3. resolve the tenant from the **verified asset id inside the payload** — never
   from a path parameter, header or query string;
4. persist the raw envelope and its dedupe key, **then** ACK;
5. everything else happens afterwards, off this path.

| | |
| --- | --- |
| Authentication | HMAC over raw bytes, constant-time, replay window. Nothing else. |
| Timeout | Meta retries on non-2xx. A storage failure is a retryable non-2xx, never a 200. |
| Duplicate delivery | `ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`. One row, one effect — and duplicates are **counted** so redelivery is visible. |
| Crash halfway | before commit, nothing is stored and Meta retries. After commit, the ACK may be lost and Meta redelivers into the dedupe key. |
| Durable before ack | **yes.** This is the whole invariant. |
| Tenant A → B | no. The tenant comes from a signature-verified asset fingerprint, resolved under a one-row-wide RLS carve-out. |
| Observed | `webhook_receipts`, one row per delivery **including refused ones**. |

**Verified by execution:** `tests/integration/api-channels.test.ts`, adapter
fixture tests in `packages/domain/src/channels/`.

**Open:** unauthenticated callers can drive `webhook_receipts` inserts
(`SECURITY_AUDIT.md`, S-6 — accepted, bounded).

### API → outbound queue → worker-interactive / campaign → provider

The most carefully built path in the product.

1. claim one message per conversation under a lease — three mechanisms, each
   covering a case the others do not: `DISTINCT ON` within the batch,
   `NOT EXISTS` against committed leases, and `pg_try_advisory_xact_lock` for
   the window where a concurrent lease has not committed yet;
2. **re-evaluate the permit now** — the messaging window may have shut, consent
   may have been withdrawn, the channel may have been disconnected since the
   agent typed;
3. write the attempt row and **commit it before the network call**;
4. send;
5. record the answer, fenced on the `dispatch_version` this worker owns.

| | |
| --- | --- |
| Timeout | `outcome_unknown`. The message leaves the outbox and is **never** automatically retried. |
| Duplicate | impossible from our side: the per-conversation gate plus the version fence. A stale worker's response is recorded as evidence and applied to nothing. |
| Crash after attempt, before response | `recoverOrphanedAttempts` marks it `outcome_unknown`. **It does not resend.** |
| Crash after provider accepted, before recording | same — `outcome_unknown`, held for a human. |
| Durable before effect | yes. The attempt row is the durable record that a request went out. |
| Retry | only for `definitely_rejected` + `retryable`, 5 attempts, exponential backoff. |
| Tenant A → B | no. Every claim and settle runs in a tenant transaction. |
| Fairness | `planRound` deals a bounded round across companies with an interactive reservation (ADR-0007); `offered` and `achieved` are both reported. |

**Verified by execution:** `api-workers`, `api-outbound`, `api-campaigns`, and
`campaign-dispatch` unit tests.

**Provider leg: UNVERIFIED against live assets.** The Meta WhatsApp Cloud API
transport is implemented and covered by 28 unit tests against a scripted Graph
API, but no real token, signature or message has been exchanged. Until it has,
`CONVO_CHANNEL_TRANSPORT` defaults to `none`, which refuses every send with a
typed reason rather than pretending.

### API → email outbox → worker-integration → Resend

**New this release.** Previously the API called a logging adapter inline and
nothing was ever sent.

| | |
| --- | --- |
| Queued | one INSERT on the **caller's transaction**, so the invitation and its email commit together or not at all. |
| Authentication to provider | bearer API key, from configuration, never stored in the database. |
| Timeout | `unknown` → retried. A duplicate invitation is an annoyance; a lost one is a person who cannot join. That asymmetry is a product decision and lives in the port, not the adapter. |
| Duplicate | `UNIQUE (kind, idempotency_key)` here, plus the provider's `Idempotency-Key` header. |
| Crash after claim, before send | the lease expires and the row is retried with `attempt_count` already advanced, so a row that kills workers exhausts its attempts rather than cycling. |
| Crash after send, before recording | retried; the provider idempotency key covers it. |
| Retry | 30s, 1m, 2m, 4m, 8m, capped at an hour, 6 attempts, then `failed` with a typed code. |
| Fail closed | `worker-integration` without an enabled provider refuses delivery with `email_provider_not_configured`; production rejects the logging adapter. Core API remains available. |
| Tenant A → B | `email_deliveries` is a global table with no tenant API over it. |
| Observed | `state`, `attempt_count`, `last_error_code`, `sent_at` per row; `backlog()` gives pending/failed/oldest. |

**Verified by execution:** 16 integration tests driving the full state machine
against a scripted provider — queue, send, scrub, retry with backoff, permanent
failure, attempts exhausted, and the generic recovery response.

**UNVERIFIED:** no email has been sent through Resend. That needs an API key and
a verified sending domain.

### API → realtime (SSE)

| | |
| --- | --- |
| Authentication | the same session cookie. |
| Revocation | the stream re-checks membership every poll, so a revoked membership stops receiving within one poll interval. |
| Slow consumer | a backlog beyond `CONVO_REALTIME_MAX_BACKLOG` tells the client to reload rather than trying to catch up. |
| Connection lifetime | capped by `CONVO_REALTIME_MAX_STREAM_MS`; the client reconnects with its cursor. |
| Duplicate | cursor-based, so a reconnect resumes rather than replays. |
| Crash | the client reconnects from its last cursor. |

**Verified by execution:** `api-realtime.test.ts`.

**UNVERIFIED:** SSE connection counts and reconnect-storm behaviour under load.
The realtime role shares the API's 10-connection pool today.

### worker-automation → schedule queue

**New this release.** Previously this ran nowhere at all: schedule
materialization had been added to `worker-integration`, which failed closed on a
broker the installation does not have and was therefore never deployed
(ADR-0018).

| | |
| --- | --- |
| Discovery | `automation_schedule_queue`, deliberately contentless — company, automation id, due time — so discovery needs no tenant context. |
| Reading the workflow | only inside that company's forced-RLS transaction. |
| Duplicate | `UNIQUE (tenant_id, automation_id, idempotency_key)` where the key is the scheduled instant. |
| Crash halfway | `FOR UPDATE OF q SKIP LOCKED`; the cursor advances in the same transaction that inserts the run. |
| Broker | not required, not consulted. |

**Verified by execution:** `api-automations.test.ts` asserts a due schedule
materializes exactly once and advances its cursor.

**INCOMPLETE — stated plainly:** nothing executes the runs it creates. See
`PRODUCTION_READINESS_REPORT.md`.

### Every process → PostgreSQL

| | |
| --- | --- |
| Pool | 10 per HTTP role; `max(4, CONVO_WORKER_CONCURRENCY)` per worker. |
| Tenant context | `SET LOCAL` **plus a read-back assertion** that the database agrees. |
| Credentials | runtime role: no `CREATE`, no `BYPASSRLS`, owns nothing. |
| Migrations | applied as the migration role by a one-shot service, never by the API. |
| Source of truth | this. Everything else is a cache or a transport. |

---

## Health and observability

| Surface | Path | Depends on |
| --- | --- | --- |
| Web | `/healthz` | nothing |
| API | `/live` | nothing — deliberately |
| API | `/ready` | PostgreSQL only |
| Worker | `/live`, `/ready`, `/metrics` | nothing / one completed tick / nothing |

`/ready` depends on **PostgreSQL only** — not on the email provider, not on a
channel provider, not on a broker. An installation whose Resend key expired must
still serve the inbox; taking the API out of rotation because a third party is
down is a self-inflicted outage.

`/live` touches nothing, so a database blip does not restart every healthy
instance at once.

**Verified by execution:** `tests/integration/api-health.test.ts`, including
that `/ready` reports 503 while `/live` still reports 200 against a dead pool.

---

## What the audit changed

| Before | After |
| --- | --- |
| Email adapters logged and sent nothing, in production | Durable outbox + Resend adapter + a worker, fail-closed configuration |
| `worker-integration` could not boot; automation scheduling lived in it | Broker requirement is conditional; scheduling has its own deployed role |
| `request.ip` was the proxy for every user | Configured trusted-hop count, counted from the right |
| No `/live` or `/ready` anywhere | Both, on every role, with the dependency split right |
| Three `console.log` calls | Structured JSON logging with correlation ids and structural redaction |
| No provider transport at all | WhatsApp Cloud API adapter, 28 tests |
| No CSP, HSTS, or frame protection | Full header set, HSTS only over TLS |
| Tenant-wide invitations returned 500 | Fixed (migration 0031) |
| Contact search: 400 round trips per request | Batched; 14–18× faster, measured |
