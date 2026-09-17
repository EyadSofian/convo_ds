# Code audit ledger

## How to read this, and what it does not claim

The brief asked for a line-by-line review of every authored file. **That is not
what happened, and saying otherwise would be the first dishonest sentence in
this report.** What happened:

- **Read in full, line by line** — the security-critical and
  production-critical paths: authentication, sessions, recovery, invitations,
  authorization, webhook ingress, outbound dispatch, credential encryption, the
  tenancy context helpers, the migration runner, all 32 migrations, the worker
  roles and loop, configuration and composition, the deployment scripts, and
  the whole (uncommitted) Automation module. Roughly 12,000 lines.
- **Pattern-swept, whole repository** — every authored file, for the specific
  risk classes the brief lists: `TODO|FIXME|HACK|XXX`, `console.*`, hardcoded
  hosts and Railway URLs, `mock|fake|demo|stub|placeholder`, `process.env`
  outside the permitted modules, unparameterised SQL, `eval`/`new Function`,
  `innerHTML`, and unawaited promises.
- **Reviewed by behaviour, not by line** — the 84-file web application, and
  the campaign and metadata services. Their behaviour is covered by 1,716 unit
  and 545 integration tests, which passed before and after every change here,
  and their risk classes were swept. They were **not** read exhaustively.

Where a file is marked `NOT_FULLY_READ`, that is the honest status. The
remaining depth is named at the end.

A useful thing the sweep found: **the pre-existing backend is exceptionally
clean.** Zero `TODO`/`FIXME`/`HACK` markers in product code. No hardcoded hosts.
No demo or mock leakage. Three `console` calls, all in process entry points.
The defects found were architectural, not sloppiness.

---

## Legend

`CLEAN` reviewed, nothing to change · `FIXED` defect found and corrected ·
`NEW` written this pass · `NEEDS_WORK` defect found, not fixed ·
`BLOCKED_EXTERNAL` needs a credential or platform action ·
`NOT_FULLY_READ` swept and behaviourally covered, not read line by line

---

## apps/api/src — composition and configuration

| File | Status | Finding / change | Proof |
| --- | --- | --- | --- |
| `main.ts` | **FIXED** | Three `console` calls were the entire production observability. Broker fail-closed was unconditional, which kept automation scheduling out of production. | Structured logger; `requiresBroker(role, configured)`; probe server. `api-workers.test.ts` |
| `app.ts` | **FIXED** | No `trustProxy` → shared rate-limit bucket (S-1). No request log. Probes were inside the versioned prefix. | `trustProxyHops`; `attachRequestLog`; `setGlobalPrefix(..., {exclude})`. `api-health.test.ts` |
| `api.module.ts` | **FIXED** | Bound the logging email adapters **in production**. | Outbox adapters; provider chosen by validated config; Meta transport selectable. |
| `config.ts` | **FIXED** | No email, proxy, transport or log configuration existed. | Four new validated fields; `worker-automation` role. `config.test.ts` |
| `client-address.ts` | **NEW** | The trusted-hop count, with the reasoning for both failure directions. | `SECURITY_AUDIT.md` S-1 |
| `tokens.ts` | **FIXED** | Added `EMAIL_PROVIDER`. | — |
| `error.filter.ts`, `http-error.ts`, `pg-error.ts`, `require-row.ts`, `pagination.ts`, `request-id.ts`, `route-inventory.ts` | **CLEAN** | Typed errors, no leakage of driver messages. `route-inventory` gained a documented exclusion for the probes. | own unit tests |

## apps/api/src/auth — authentication, sessions, recovery

| File | Status | Finding / change | Proof |
| --- | --- | --- | --- |
| `auth.service.ts` | **NEEDS_WORK** | Argon2id parameters, dummy-hash timing defence, token fingerprinting and CSRF are all correct. Two open items: a successful login resets the **IP** bucket (S-8); `authenticate()` writes `last_seen_at` on every request (S-9). | `api-auth.test.ts` |
| `auth-tokens.ts` | **CLEAN** | 32-byte tokens, HMAC fingerprints, `timingSafeEqual` with a length guard, correct cookie paths and flags. | `auth-tokens.test.ts` |
| `auth-rate-limiter.ts` | **CLEAN** | Counter in PostgreSQL, not in a process. Correct windowing. Its *input* was the bug (S-1), not this. | `auth-rate-limiter.test.ts` |
| `auth.controller.ts`, `auth-request.ts` | **CLEAN** | Allow-list parsing; identical 202 for recovery regardless of account. | `api-auth`, `api-recovery` |
| `recovery.service.ts` | **FIXED** | Inline provider call after commit — a latency and failure-mode oracle for real accounts (S-3). | Challenge + outbox row in one transaction. `api-email.test.ts` |
| `recovery-delivery.ts` | **FIXED** | Port now takes the caller's executor. | `api-recovery.test.ts` |

## apps/api/src/email — NEW

| File | Status | Proof |
| --- | --- | --- |
| `email-provider.port.ts` | **NEW** — three-outcome port; the retry asymmetry versus messaging is stated where it is decided | 14 tests |
| `resend.provider.ts` | **NEW** — HTTP adapter, timeout, outcome classification by "can time fix it", scrubs recipient **and** API key from provider error text | 14 tests |
| `email-config.ts` | **NEW** — fail-closed in production, reports every problem at once | 21 tests |
| `email-outbox.service.ts` | **NEW** — claim-before-send, backoff, scrub-on-terminal, backlog | 16 integration tests |
| `outbox-delivery.ts` | **NEW** — the two port bindings; one INSERT each, no branching on provider | 16 integration tests |

## apps/api/src/channels

| File | Status | Finding / change | Proof |
| --- | --- | --- | --- |
| `ingress.service.ts` | **CLEAN** | Raw-bytes signature, verify-before-parse, tenant from the verified payload, journal-then-ACK. Textbook. | `api-channels.test.ts` |
| `raw-body.ts` | **CLEAN** | Route gets no parsed body at all, so nothing downstream can trust a field early. | — |
| `ingress-journal.ts` | **CLEAN** | Dedupe key with `ON CONFLICT DO NOTHING`; duplicates counted, not hidden. | — |
| `dispatcher.service.ts` | **NEEDS_WORK** | The lease, the three-layer per-conversation gate, the version fence and the `outcome_unknown` discipline are all correct. `recoverOrphanedAttempts` has no `LIMIT` (D-5). | `api-workers`, `api-outbound` |
| `credential-cipher.ts` | **CLEAN** | AES-256-GCM, per-record IV, separate tag, AAD binding tenant+connection+purpose, versioned keys. | own tests |
| `node-crypto.ts` | **CLEAN** | Constant-time, length-checked. | — |
| `meta-whatsapp.transport.ts` | **NEW** / **BLOCKED_EXTERNAL** | Real Cloud API adapter. Never run against live assets. | 28 unit tests |
| `transport-config.ts` | **NEW** | Why this one does **not** fail closed, unlike email. | — |
| `channel.service.ts`, `normalization.service.ts`, `outbound.service.ts`, `self-hosted-ingress.service.ts`, `credential.service.ts`, `adapters.ts` | **CLEAN** | Read; no defects found. | `api-channels` |

## apps/api/src — other modules

| Area | Status | Notes |
| --- | --- | --- |
| `authorization/` | **CLEAN** | Every tenant-scoped call passes through `authorized`, which sets RLS context. Permission checks are by key, never by role name. |
| `people/`, `memberships/` | **FIXED** | Invitation delivery is transactional. The last-Owner deferred constraint and the delegation ceiling are correct. Tenant-wide invitations were broken by the schema, not by this code (D-2). |
| `instance/` | **CLEAN** | Bootstrap token, idempotency, one-installation invariant. |
| `idempotency/` | **CLEAN** | Canonical JSON + request hash; a retry with a different body is a conflict, not a replay. |
| `conversations/` | **NOT_FULLY_READ** | Lifecycle, routing, notes, timeline read at the level of their queries and transactions; not exhaustively. Covered by `api-conversations`, `api-routing`, `api-lifecycle`. |
| `campaigns/` | **NOT_FULLY_READ** | Dispatch, planner, reporting, export read at the level of their state machines. Covered by `api-campaigns` and unit tests. |
| `metadata/` | **FIXED** | `readMetadata` was called per row from contact list — 400 round trips. Added `readMetadataBatch`. | `LOAD_TEST_REPORT.md` |
| `contacts/` | **FIXED** | The N+1 call site. | measured 14–18× |
| `segments/`, `realtime/`, `broker/` | **NOT_FULLY_READ** | Swept; covered by their integration tests. |
| `health/` | **NEW** | Liveness/readiness with the dependency split argued in the file. | 8 tests |
| `observability/logger.ts` | **NEW** | Deny-list **and** a structural rule: objects are never expanded. | 27 tests |
| `workers/worker-roles.ts` | **FIXED** | Automation scheduling was jammed into the broker-gated worker on two unformatted lines. Separated into `worker-automation`; email drain added to `worker-integration`. | ADR-0018 |
| `workers/worker-loop.ts` | **FIXED** | Added the heartbeat fields a wedged loop is only visible through. | `worker-loop.test.ts` |
| `workers/probe-server.ts` | **NEW** | `/live`, `/ready`, `/metrics` for roles that bind no API port. | — |
| `automations/` | **NEEDS_WORK** | Definition CRUD, validation, transitions, schedule computation and trigger intake are correct and idempotent. **No executor exists** — see below. | `api-automations.test.ts` |

### The automation gap, stated plainly

`automation_runs` rows are created and **nothing ever processes them**. There is
no writer anywhere in the codebase for `automation_recipients` or
`automation_logs` — verified by grep across `apps/`, `packages/` and `tests/`;
the only matches are in the migration test's table manifest.

Concretely missing: run execution (`queued` → `running` → `completed`), target
resolution, recipient planning, ordered step execution, delayed steps, the
messaging action, retries, duplicate suppression, and test execution.

There is also a **second, independent blocker**: `whatsapp_templates` is never
populated by any code, and `validateTemplates` refuses activation when a
`send_whatsapp_template` step names a template that is not in that table. So no
automation containing a template step — which is most of the 19 seeded presets —
can be activated at all, even once an executor exists. It needs a template sync
against Meta, which needs live assets.

## packages/domain/src

| Area | Status | Notes |
| --- | --- | --- |
| `channels/` | **CLEAN** | Adapters, capability matrices, signature scheme, fairness planner, delivery fold. Pure and fixture-tested. The `foldDelivery` anomaly handling is unusually careful. |
| `iam/` | **CLEAN** | Permissions by key, delegation ceiling, role matrix. |
| `installation/` | **CLEAN** | The **only** place an environment variable becomes a deployment mode, and a test greps first-party source to keep that true. |
| `conversations/`, `conditions/`, `metadata/`, `campaigns/`, `realtime/` | **NOT_FULLY_READ** | Swept; covered by unit tests. |
| `automations/` | **CLEAN** | Workflow and schedule validation are sound, including DST handling via `Intl` round-tripping. |
| `email/messages.ts` | **NEW** | Templates as pure functions; HTML-escaped, RTL/LTR, UTC expiry, links from `CONVO_PUBLIC_BASE_URL` only. | 18 tests |
| `index.ts` | **FIXED** | Extended; the public-surface pin test was updated deliberately, member by member. |

## packages/database

| File | Status | Notes |
| --- | --- | --- |
| `migrate.ts` | **NEEDS_WORK** | Checksums, per-file transaction, rollback all correct. No advisory lock (D-1) — a concurrent run fails loudly rather than corrupting. |
| `context.ts` | **CLEAN** | `SET LOCAL` **plus a read-back assertion**. The two credential carve-outs are one-column narrow. The best file in the repository. |
| `transaction.ts`, `bootstrap.ts`, `cli.ts`, `bin.ts` | **CLEAN** | Thin, correct, no added behaviour. |
| `migrations/0001`–`0029` | **CLEAN** except as noted | All 31 read line by line. RLS `ENABLE`+`FORCE` with `USING`+`WITH CHECK` throughout. Partial indexes used correctly. |
| `migrations/0008` | **FIXED by 0031** | The PK/CHECK contradiction (D-2). |
| `migrations/0030` | **NEW** | Email outbox. |
| `migrations/0031` | **NEW** | The invitation-scope fix. |

**Removed during this pass:** a `pg_trgm` index migration, written on a
plausible-sounding argument about leading wildcards, measured at under 3%
improvement, and deleted. `EXPLAIN ANALYZE` showed the query was never the
problem. Recorded because the discipline is the point: no index ships without a
measurement.

## apps/web

| Area | Status | Notes |
| --- | --- | --- |
| `server.mjs` | **FIXED** | No CSP/HSTS/frame protection (S-4). `X-Forwarded-For` passed through untouched (S-1). Path traversal was already correctly guarded. |
| `index.html`, `vite.config.ts` | **CLEAN** | Self-hosted fonts, no third-party origins, same-origin API by design. |
| `src/**` (84 files) | **NOT_FULLY_READ** | Swept for `innerHTML`, direct DOM sinks, hardcoded hosts, `process.env`, secrets. The render path uses `textContent`. Covered by 34 unit test files plus Playwright. **A focused frontend security review is outstanding.** |

## tests/ and tooling

| Area | Status | Notes |
| --- | --- | --- |
| `tests/integration/**` | **FIXED** | Updated for the transactional delivery ports, the new migrations, and the new broker semantics. Two new files: `api-email` (16), `api-health` (8). |
| `tests/recovery/**` | **NEW** | The restore drill. `test:recovery` was `exit 1`; it is now 13 passing tests. |
| `tests/load/**` | **NEW** | Harness, seeder, runner, `EXPLAIN` suite. `test:load:target` was `exit 1`; it now measures. |
| `tests/e2e/**` | **NOT_RUN** | Playwright browsers are not installed here. |
| `Dockerfile`, `deploy/start.sh` | **CLEAN** | `start.sh` already routes worker roles through the default branch; the new roles need no change to it. |
| `.github/**` | **NOT_FULLY_READ** | One workflow file; read, not audited against the new gates. |
| `.env.example` | **FIXED** | Rewritten: every new variable, and the consequence of getting `CONVO_TRUSTED_PROXY_HOPS` wrong in both directions. |

---

## Defect summary

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 1 | 1 | 0 |
| High | 4 | 4 | 0 |
| Medium | 6 | 2 | 4 |
| Low | 2 | 0 | 2 |

Open items, all recorded with the work to close them: S-6 (webhook receipt
inserts), S-7 (token at rest in the outbox), S-8 (IP bucket reset), S-9
(`last_seen_at` write amplification), D-1 (migration advisory lock), D-4
(retention), D-5 (unbounded recovery sweep).

## Audit depth still owed

1. **`apps/web/src`, 84 files**, line by line — the largest unread area, and the
   one where an XSS would live.
2. **`apps/api/src/conversations` and `campaigns`** — read by query and state
   machine, not by line.
3. **Domain modules** outside channels, IAM and installation.
4. **The CI workflow**, against the gates this pass added.
