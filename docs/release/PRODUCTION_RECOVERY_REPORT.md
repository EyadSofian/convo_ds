# CONVO PRODUCTION RECOVERY REPORT

## INCIDENT

Cause: a Railway GitHub source association intended for staging applied at
shared-service scope and created production deployments. Process-wide email
configuration validation then prevented the API and four workers from starting.

Impact: the production public API returned 502 while the web service and
PostgreSQL remained available. Provider messaging was not active. The measured
API incident ran from 09:46:43 UTC to readiness at 17:12:56 UTC on 2026-09-18:
7 hours, 26 minutes and 13 seconds.

Schema impact: the production migration service advanced the database from 0025
to 0032. No downgrade, migration removal, or destructive restore was attempted.

## ROOT CAUSE

- Railway source association behavior: source was attached to a service shared
  by both environments, not only to the selected staging instance.
- Config validation behavior: `CONVO_EMAIL_PROVIDER` was globally required in
  production even though only `worker-integration` calls the email provider.
- Deployment coupling: shared GitHub triggers allowed a staging source action
  to create matching production deployments without an explicit production
  release command.

The failed API logs repeatedly recorded
`api_configuration_invalid: ... CONVO_EMAIL_PROVIDER (required)` before the
server bound its port. Railway marked deployment
`70704d78-f0f3-4a2d-b1be-64c52fb7a6fd` FAILED. No numeric process exit code is
exposed by the retained Railway deployment record.

## DATABASE

- Current ledger: 32 rows; high-water mark `0032_automation_execution.sql`.
- PostgreSQL deployment: `926405dd-b589-43c2-8b58-0717173249fb`, healthy.
- Attached volume: `185461b4-517e-489e-b07c-208f751c159b`.
- PITR reports enabled and bucket wired. The CLI live coverage probe is
  unavailable because Railway reports `no_ssh_key`; this is recorded rather
  than treated as positive continuous-coverage proof.
- Pre-recovery backup: `1b94f948-bf61-4ebd-94ff-15e058d73e2d`, named
  `pre-convo-v1.0.0-rc.2-recovery`, with no expiry.
- Queue snapshot after recovery: channel, outbound, campaign, report-export,
  automation, pending-email, and failed-email counts were all zero.

### Schema 0032 compatibility

| Change | Older production API risk | Recovery candidate result |
| --- | --- | --- |
| 0026 expands custom-field types and replaces validation trigger | Existing types remain valid; no column removed | Covered by full integration suite |
| 0027 adds views/audiences | Additive | Covered |
| 0028 adds automation tables/permissions | Additive | Covered |
| 0029 adds event/schedule queues and strengthens nullable recipient uniqueness | Could reject duplicate legacy nullable identities; no read contract removed | Covered |
| 0030 adds email outbox | Additive | Covered |
| 0031 relaxes invitation scope nullability and replaces its uniqueness key | Older reads remain shaped the same | Covered |
| 0032 adds automation execution columns/tables and expands recipient statuses | Existing statuses remain accepted; new columns have defaults | Covered |

Static review found no table or column rename/drop in 0026–0032. The unknown old
artifact was not redeployed because runtime compatibility was not independently
proven. Recovery candidate `v1.0.0-rc.2` was tested against a fresh 0032 schema
and then booted successfully against production 0032.

## API

- Previous failure: required unused email provider configuration and exited
  before port binding.
- Fix: provider validation is scoped to `worker-integration`; API binds the
  explicit refusing adapter and reports no synthetic delivery success.
- Release: `v1.0.0-rc.2` / `91b26d06c6de3ba3fe0f7547d9aadba56a83fec0`.
- Deployment: `6292ce47-8585-4896-a670-11a005da5653`, SUCCESS.
- Private `/live`: PASS, 200.
- Private `/ready`: PASS, 200.
- Public `/api/v1/instance`: PASS, 200.
- Startup log: `process_started`, role `api`, email provider `disabled`, trusted
  proxy hops `2`; no repeated boot error.

## WEB

- Deployment: `e0a80d92-6755-4b8a-9043-65f34f91e19f` at the original tested
  SHA `eac8b262c5b6eadf3289327ce1bbabd40249a7dc`; no web code changed in recovery.
- `/healthz`: PASS, 200.
- Root/login shell: PASS, 200.
- Public API proxy: PASS, instance response 200.

## WORKERS

No production worker was deployed or activated during core recovery.

| Role | Class | Current decision |
| --- | --- | --- |
| inbound | PROVIDER_REQUIRED | disabled; no Meta activation |
| interactive | PROVIDER_REQUIRED | disabled; no Meta activation |
| campaign | PROVIDER_REQUIRED | disabled; no Meta activation |
| report | OPTIONAL | disabled; not required for core recovery |
| integration | PROVIDER_REQUIRED | disabled; no Resend activation |
| automation | OPTIONAL / provider-adjacent | disabled; no outbound activation |

The four incident deployments remain FAILED and inactive; there is no current
restart loop. Worker health endpoints are therefore NOT RUN, not falsely PASS.

## CONFIG CONTRACT

- API and unrelated workers validate core database, auth, process-role, port,
  public-origin, and proxy contracts, but ignore email-provider-only fields.
- `worker-integration` accepts explicit `disabled`, or requires complete Resend
  sender/key values when `resend` is enabled.
- Production rejects the logging email adapter.
- Missing provider configuration returns a typed
  `email_provider_not_configured` refusal; it never records a fake send.
- Meta transport remains `none` until authorized connection credentials exist.

## RAILWAY ISOLATION

Old design: GitHub source triggers were attached to shared Railway services and
could deploy both environment instances.

New design: all nine application services report source disconnected. Staging
and production use explicit CLI uploads from a clean detached worktree at a
full remote SHA. Every command names project, environment ID, and service.
Production additionally requires an exact version tag and
`--confirm-production`; no command defaults to production.

Proof: staging API deployment `1c1fe476-51e0-48b6-8fa3-c58308778ab9`
successfully deployed rc.2. Afterward every production deployment ID remained
unchanged and the production migration ledger remained 32/0032. No automated
source trigger was reconnected.

## GITHUB RELEASE FLOW

- PR #3 contains the recovery, explicit deploy scripts, and workflows. GitHub
  `verify` passed on exact SHA `91b26d06c6de3ba3fe0f7547d9aadba56a83fec0`.
- Staging workflow requires an explicit SHA and service and targets only the
  staging environment ID.
- Production workflow is `workflow_dispatch` only, requires the typed word
  `PRODUCTION`, an immutable tagged SHA, an explicit service, and the protected
  GitHub `production` environment.
- GitHub production environment requires reviewer approval. The workflows need
  the environment-scoped `RAILWAY_TOKEN`, which has not been configured.
- PR #1 CI/release validation is correct and green, but PR #1 and PR #3 remain
  review-required. Branch protection was not bypassed.

## MIGRATIONS

Production verification deployment
`a2e141f5-4929-45cc-9227-d94af356257f` reported `no pending migrations` and
left the ledger at 32/0032. The migration runner now takes a session-level
PostgreSQL advisory lock, waits for at most 60 seconds, reports a clear timeout,
and releases the lock on completion or connection termination. Integration
tests prove concurrent migrators serialize and timeout is bounded.

## PRODUCTION CORE SMOKE

| Check | Result | Evidence |
| --- | --- | --- |
| Web health | PASS | `/healthz` 200 |
| API live | PASS | private `/live` 200 |
| API ready | PASS | private `/ready` 200 and Railway deployment SUCCESS |
| Public proxy | PASS | `/api/v1/instance` 200 |
| Login shell/core boot | PASS | root 200; installed instance descriptor 200 |
| Anonymous session boundary | PASS | `/api/v1/auth/session` returns typed 401 |
| Authenticated login | NOT RUN | no approved synthetic production credential |
| Authenticated session read | NOT RUN | no approved synthetic production credential |
| Membership read | NOT RUN | no approved synthetic production credential |
| Inbox data | NOT RUN | customer data was not accessed |
| Logout | NOT RUN | no approved synthetic session was created |
| Queue depth | PASS | all measured core/provider queues zero |

## PROVIDERS

- Resend: **BLOCKED_EXTERNAL** — API key, verified sender, and live delivery
  evidence absent. Email is not live.
- Meta: **BLOCKED_EXTERNAL** — authorized app/assets/tokens/test recipient and
  live inbound/outbound evidence absent. WhatsApp is not live.
- Alert destination: **BLOCKED_EXTERNAL_CONFIG** — no named destination.

## RECOVERY

The earlier isolated native restore attempt remains
`BLOCKED_EXTERNAL_RAILWAY_PERMISSION` (`OAUTH_INSUFFICIENT_GRANT`). No restore
was attempted against the selected live production volume. Existing PITR,
scheduled backups, the rc.1 locked point, and the new rc.2 pre-recovery point
remain available.

## REMAINING BLOCKERS

- Review and merge PR #1 and PR #3 without bypassing branch protection.
- Configure environment-scoped `RAILWAY_TOKEN` for GitHub deployment workflows.
- Resolve Railway permission for a truly isolated native restore/readback.
- Supply and verify Resend and Meta credentials with controlled live tests.
- Name and test an alert destination.
- Run authenticated production smoke only with an approved synthetic account.

## FINAL STATUS

`CORE_PRODUCTION_RECOVERED_PROVIDER_ACTIVATION_BLOCKED`

Core API/web/database availability is restored at schema 0032. This is not a
customer-messaging GO: email, Meta, provider-dependent workers, and alert
delivery remain deliberately inactive.
