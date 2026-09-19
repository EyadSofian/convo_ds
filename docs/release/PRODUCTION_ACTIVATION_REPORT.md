# CONVO PRODUCTION ACTIVATION REPORT

Status date: 2026-09-18

## RELEASE

- Production recovery tag: `v1.0.0-rc.2`.
- Production recovery SHA: `91b26d06c6de3ba3fe0f7547d9aadba56a83fec0`.
- `main` remains at `eac8b262c5b6eadf3289327ce1bbabd40249a7dc`.
- PR #1 (`hardening/github-ci-release`) is green at
  `b4de6392bdafd6c3016078eb23c710b3d00f79e7` after strengthening release
  validation to require a published version tag and the exact migration
  high-water mark.
- PR #3 (`hardening/production-recovery`) is green and contains the deployed
  recovery runtime, explicit Railway deployment mechanism, role-scoped config,
  and migration advisory lock.
- Neither PR is merged. Both are `BLOCKED_EXTERNAL_APPROVAL`: branch protection
  requires one approval, the PR author is the repository's only collaborator,
  and self-approval is unavailable. Admin bypass was not used.
- `main` requires an up-to-date `verify` check, one approval, stale-review
  dismissal, linear history, and prevents force pushes and deletion.
- GitHub environment `production` requires reviewer `EyadSofian`.

No final post-merge tag was created because no merge occurred. Production was
not silently moved away from the validated rc.2 runtime.

## RAILWAY

Deployment remains an explicit CLI upload from a clean detached worktree at a
full remote SHA. Every command names project, environment ID, and service;
production additionally requires a published version tag and explicit
confirmation. All staging and production application sources report
`disconnected`; no branch push can auto-deploy production.

The prior isolation proof remains valid: staging API deployment
`1c1fe476-51e0-48b6-8fa3-c58308778ab9` changed staging while every production
deployment ID and the production migration ledger remained unchanged. The new
GitHub workflow could not be rerun because it is not merged and neither GitHub
environment has `RAILWAY_TOKEN` configured.

| Production service | Deployment | Status | Recorded release SHA |
| --- | --- | --- | --- |
| Postgres | `926405dd-b589-43c2-8b58-0717173249fb` | SUCCESS | managed image |
| `convo-database` | `a2e141f5-4929-45cc-9227-d94af356257f` | SUCCESS | rc.2 SHA |
| `convo-api` | `6292ce47-8585-4896-a670-11a005da5653` | SUCCESS | rc.2 SHA |
| `convo-client-demo` | `e0a80d92-6755-4b8a-9043-65f34f91e19f` | SUCCESS | variable not set; incident deployment came from original release SHA |
| `convo-worker-inbound` | `a19730bc-cfac-45fe-85c4-1a94358ee8a7` | FAILED / inactive | not set |
| `convo-worker-interactive` | `0bf80d98-a5f5-4cb7-b761-c843bf226f34` | FAILED / inactive | not set |
| `convo-worker-campaign` | `21b54e54-556b-465e-839b-c6019e3e8443` | FAILED / inactive | not set |
| `convo-worker-report` | `f2b0536f-129a-411f-b6b4-8a20eb03ff2d` | FAILED / inactive | not set |
| `convo-worker-integration` | no production deployment | intentionally disabled | not set |
| `convo-worker-automation` | no production deployment | intentionally disabled | not set |

The required same-SHA live-pilot topology therefore does not yet exist.

## DATABASE

- Migration count: 32.
- High-water mark: `0032_automation_execution.sql`.
- Checksum comparison: all 32 production ledger checksums match the repository;
  zero mismatches.
- The rc.2 migration verification deployment reported `no pending migrations`.
- PITR: enabled; bucket wired. Railway's live coverage/archiver probe still
  reports `no_ssh_key`, so continuous coverage is not overstated.
- Latest locked recovery point:
  `1b94f948-bf61-4ebd-94ff-15e058d73e2d`
  (`pre-convo-v1.0.0-rc.2-recovery`, no expiry).
- Queue snapshot: inbound, outbound, campaign, report-export, automation,
  pending-email, and failed-email counts are all zero.

## AUTHENTICATED PRODUCTION SMOKE

| Step | Result | Evidence / reason |
| --- | --- | --- |
| Web health | PASS | `/healthz` 200 |
| API live | PASS | private `/live` 200 |
| API ready | PASS | private `/ready` 200 |
| Public API proxy | PASS | `/api/v1/instance` 200 |
| Login | NOT RUN | no approved production synthetic credential |
| Session | NOT RUN | no approved synthetic session |
| Membership | NOT RUN | no approved synthetic session |
| Inbox / conversation | NOT RUN | customer records were not accessed |
| Assignment / note / label / priority | NOT RUN | no approved synthetic conversation |
| Resolve / reopen / audit | NOT RUN | no approved synthetic conversation |
| Logout | NOT RUN | no synthetic session was created |

The installation is already bootstrapped. Creating a user now requires the real
admin/invitation path and an authorized admin session; no insecure password hash
or direct production row was injected.

## RESEND

- Configuration: absent. Production variable names do not contain
  `CONVO_EMAIL_PROVIDER`, `CONVO_EMAIL_FROM`, or `CONVO_RESEND_API_KEY`.
- Invitation delivery: NOT RUN.
- Password recovery: NOT RUN.
- Provider IDs: none.
- Live failure/retry behavior: NOT RUN. Scripted 429/500/timeout/unknown paths
  remain covered by repository tests, not claimed as live provider evidence.
- `convo-worker-integration` remains intentionally undeployed.

Status: `BLOCKED_EXTERNAL_CONFIG`.

## META

- Authorized app, system-user token, WABA, phone-number ID, verify token, and
  approved recipient were not supplied.
- Asset ownership: NOT VERIFIED.
- Webhook verify challenge/signature: NOT RUN live.
- Template synchronization: NOT RUN.
- Real inbound, outbound, template message, and receipts: NOT RUN.
- No provider ID or customer message content was fabricated or recorded.

Status: `BLOCKED_EXTERNAL_CONFIG`.

## WORKERS

| Role | Deployment | Health | Queue |
| --- | --- | --- | --- |
| integration | disabled | NOT RUN | email queue 0 |
| inbound | failed incident deployment; inactive | NOT RUN | inbound queue 0 |
| interactive | failed incident deployment; inactive | NOT RUN | outbound queue 0 |
| campaign | failed incident deployment; inactive | NOT RUN | campaign queue 0 |
| report | failed incident deployment; inactive | NOT RUN | report queue 0 |
| automation | disabled | NOT RUN | automation queue 0 |

No missing-provider crash loop is currently running. Provider-dependent workers
were not started without credentials.

## AUTOMATION

Controlled run, recipient plan, action log, provider state, idempotent replay,
and restart/lease-reclaim verification are all NOT RUN because Meta assets and
the automation worker are not active. No broad automation was enabled.

## CAMPAIGN

The 1–3-recipient internal micro-pilot is NOT RUN. No customer campaign or bulk
provider traffic was launched.

## ALERTING

- Destination: not supplied (`BLOCKED_EXTERNAL_CONFIG`).
- Warning delivery: NOT RUN.
- Critical delivery: NOT RUN.
- Existing thresholds and redaction requirements remain documented; no
  destination was invented.

## OBSERVABILITY

One-hour Railway snapshot after recovery:

- Web: 4 requests, 0% errors, p95 96 ms.
- API: approximately 58.8 MB memory and negligible CPU; private HTTP is not
  represented in Railway's public HTTP summary.
- PostgreSQL: approximately 95.7 MB memory, negligible CPU, 10 active/idle
  backend connections observed against `max_connections=500`.
- PostgreSQL volume: approximately 1,239 MB of 50,000 MB.
- Current API and web log scans: zero error/fatal/boot-failure lines in the
  retained sample.
- All measured queues: depth zero.

There is no activated-provider observation window to evaluate yet.

## SECURITY

- PR #1 CI passed lint, typecheck, build, unit, integration, property,
  contracts, security, and 100% coverage gates.
- PR #3 CI passed its required `verify` gate; the recovery SHA had already
  passed the same runtime suite before deployment.
- Diff review found no Railway source connection, automatic production trigger,
  destructive restore/downgrade, credential value, or production logging-email
  fallback.
- Branch protection remains active and was not bypassed.
- Live provider signature, authorization, delivery, and receipt paths remain
  unverified and are release blockers.

## OPEN RISKS

### Critical

- None newly identified in the healthy core. Pilot activation is withheld, so
  unverified providers are not exposed to customers.

### High

- PR #1 and PR #3 cannot merge without an independent authorized reviewer.
- No GitHub environment-scoped `RAILWAY_TOKEN`; the approved workflow path
  cannot execute.
- Authenticated production smoke is incomplete.
- Resend and Meta live paths, provider-dependent workers, automation, campaign,
  and alert delivery are unverified.
- Final live services do not yet share one recorded application SHA.

### Medium

- Isolated native Railway restore/readback remains blocked by external Railway
  permission.
- PITR live coverage probe cannot authenticate even though PITR reports enabled
  and bucket wired.
- The pilot text's `70/100` database trigger no longer matches the platform's
  reported `max_connections=500`. Retain the conservative absolute limit of 70
  for the pilot until monitoring is configured; the canonical runbook remains
  warning at 70% and critical at 85%.

### Low

- GitHub reports action-runtime/runner migration notices. They do not fail the
  current gates but should be handled in routine CI maintenance.

## PILOT CAPACITY

The unactivated planning envelope remains:

- up to 25 simultaneously active operators;
- two API replicas for availability;
- one replica per enabled worker role initially;
- scale/retest at API p95 above 750 ms for five minutes, errors above 1%, CPU
  above 70%, memory above 75%, conservative database connections above 70,
  interactive/inbound queue age above 30 seconds, bulk/automation/report queue
  age above five minutes, or worker heartbeat over 60 seconds stale.

This is a future controlled-pilot ceiling, not current approval and not an
unlimited-production claim.

## FINAL DECISION

`NO_GO`

Production core remains healthy and isolated, but the independent PR approval,
deployment credential, authenticated smoke, real Resend/Meta evidence, worker
health, controlled automation/campaign tests, and alert delivery required for a
pilot are not available. Provider activation was not attempted.
