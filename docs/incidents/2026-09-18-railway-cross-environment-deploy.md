# Incident: Railway cross-environment deployment

Status: core production recovered; provider activation blocked
Date: 2026-09-18
Severity: production availability / release isolation
Customer messaging: not activated

## Summary

A GitHub source was connected to shared Railway services while targeting
staging. Railway associates that source at service scope and created deployment
triggers for matching service instances in both staging and production. The
production migration job ran successfully and advanced schema 0025 to 0032.
The release web deployed, while the release API and four existing workers
failed startup. The public production API returned 502.

No database downgrade was attempted. GitHub sources were disconnected from all
nine application services. PostgreSQL remained healthy and its original volume
stayed attached. Meta and Resend remained disabled.

## Timeline

- 09:45:04 UTC — production migration deployment
  `e464654a-d168-49d6-8460-40502c1490be` created from release SHA
  `eac8b262c5b6eadf3289327ce1bbabd40249a7dc`.
- 09:45:53 UTC — migrations 0026 through 0032 reported applied.
- 09:45:50 UTC — production API deployment
  `70704d78-f0f3-4a2d-b1be-64c52fb7a6fd` created.
- 09:45:57 UTC — production web deployment
  `e0a80d92-6755-4b8a-9043-65f34f91e19f` created and later became healthy.
- 09:46:43 UTC — API began repeated fail-closed startup exits naming
  `CONVO_EMAIL_PROVIDER (required)`.
- During incident verification — all application GitHub source associations
  were disconnected; staging deployments remained healthy and immutable.
- 17:05:21 UTC — isolated staging API deployment
  `1c1fe476-51e0-48b6-8fa3-c58308778ab9` created from recovery SHA
  `91b26d06c6de3ba3fe0f7547d9aadba56a83fec0`; every production deployment ID
  and the 32-row migration ledger remained unchanged.
- 17:09:15 UTC — locked pre-recovery production backup
  `1b94f948-bf61-4ebd-94ff-15e058d73e2d` created.
- 17:09:50 UTC — production migration verification deployment
  `a2e141f5-4929-45cc-9227-d94af356257f` reported `no pending migrations`.
- 17:11:29 UTC — production API recovery deployment
  `6292ce47-8585-4896-a670-11a005da5653` created.
- 17:12:56 UTC — production API `/ready` returned 200. The measured API
  availability incident was 7 hours, 26 minutes and 13 seconds.

## Trigger and contributing conditions

The initiating trigger was a Railway GitHub source association whose scope was
assumed to be the selected environment but was in fact the shared service.
Production had matching service instances, so source connection created
production triggers as well.

Availability impact was extended by a process-wide configuration contract.
`parseApiConfig` required a production email provider for every process role,
although only `worker-integration` calls that provider. Missing Resend
configuration therefore stopped API, inbound, interactive, campaign and report
roles before database initialization or port binding.

## Affected services

| Service | Incident deployment | Result |
| --- | --- | --- |
| `convo-database` | `e464654a-d168-49d6-8460-40502c1490be` | SUCCESS; schema advanced to 0032 |
| `convo-client-demo` | `e0a80d92-6755-4b8a-9043-65f34f91e19f` | SUCCESS; `/healthz` 200 |
| `convo-api` | `70704d78-f0f3-4a2d-b1be-64c52fb7a6fd` | FAILED; public API 502 |
| `convo-worker-inbound` | `a19730bc-cfac-45fe-85c4-1a94358ee8a7` | FAILED at config validation |
| `convo-worker-interactive` | `0bf80d98-a5f5-4cb7-b761-c843bf226f34` | FAILED at config validation |
| `convo-worker-campaign` | `21b54e54-556b-465e-839b-c6019e3e8443` | FAILED at config validation |
| `convo-worker-report` | `f2b0536f-129a-411f-b6b4-8a20eb03ff2d` | FAILED at config validation |

Production integration and automation instances were not activated.

## Database and recovery protection

- Live query: 32 `schema_migrations` rows; high-water mark
  `0032_automation_execution.sql`.
- PostgreSQL deployment: `926405dd-b589-43c2-8b58-0717173249fb`, healthy.
- Attached production volume: `185461b4-517e-489e-b07c-208f751c159b`, ready,
  approximately 1,204 MB.
- PITR: enabled and bucket wired.
- Latest scheduled recovery point:
  `10f3bd8c-ed52-4d34-8ef4-f3e6641de3`.
- Locked release recovery point:
  `80951af4-c581-4d5e-a8df-93dad3ce5091`.

Migrations 0026–0032 are forward-only and were not removed or reversed.

## Immediate mitigation

- Disconnected GitHub sources from all nine application services.
- Confirmed every source association now reports disconnected.
- Kept the database and attached production volume unchanged.
- Kept logging email and fake Meta transports out of production.
- Created protected GitHub environments: staging and production. Production
  requires an explicit reviewer before its deployment job can proceed.

## Corrective actions

- Scope email-provider validation to `worker-integration`; bind all unrelated
  roles to an explicit provider-disabled adapter.
- Keep missing provider behavior typed as `email_provider_not_configured`; do
  not silently fall back to logging or synthetic success.
- Serialize migration jobs with a bounded PostgreSQL advisory lock.
- Replace Railway source triggers with an explicit environment/service/SHA
  deployment command. Production additionally requires a version tag, typed
  confirmation and protected GitHub Environment approval.
- Prove a staging deployment leaves all production deployment IDs and the
  production migration count unchanged before any future automation is enabled.

## Current production state

Production web health, API `/live`, API `/ready`, and the public API proxy are
all 200. PostgreSQL remains healthy at schema 0032. No worker or provider was
activated during core recovery. Provider-dependent capabilities remain blocked.
The final evidence is recorded in `docs/release/PRODUCTION_RECOVERY_REPORT.md`.
