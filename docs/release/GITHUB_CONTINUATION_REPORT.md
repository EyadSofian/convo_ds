# CONVO GITHUB + CONTINUATION REPORT

Date: 2026-09-18  
Decision: **production NO-GO**

## GitHub

| Item | Verified value |
| --- | --- |
| Repository | `https://github.com/EyadSofian/convo_ds` |
| Default branch | `main` |
| Release branch | `release/production-hardening` |
| Release tag | `v1.0.0-rc.1` |
| Release SHA | `eac8b262c5b6eadf3289327ce1bbabd40249a7dc` |

The target was empty before the first push. The release branch and tag were
pushed first. A pre-existing local `main` pointed to an ancestor, so it was
fast-forwarded without force to the release commit and pushed. After fetch and
tag dereference, remote `main`, remote release branch and the tag all resolved
to the exact tested SHA. The GitHub default branch is `main`.

Full-history token-pattern inspection found only dependency checksums and test
fixtures; no real credential was identified. Environment files, dependencies,
coverage/build output, dumps and private runtime material are ignored.

## Clean clone verification

A new clone at `/tmp/convo-github-verification` selected `main` at the release
SHA and contained the expected monorepo/runtime files. From that clone:

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| lint | PASS |
| typecheck | PASS |
| build | PASS |
| unit | PASS — 103 files, 1,847 tests |
| integration | PASS — 27 files, 574 tests |
| property | PASS — 5 tests |
| contracts | PASS — 170 unit + 123 integration |
| security | PASS — 377 tests plus dependency audit |
| coverage | PASS — 131 files, 2,426 tests, 100% |

## GitHub CI

The original `CI` workflow validates locked install, lint, typecheck, build,
unit, integration and coverage. PR #1 (`hardening/github-ci-release`) adds
property, contracts and security to the required `verify` job and adds a
manual `Release validation` workflow for e2e, accessibility, visual, recovery,
load and mutation gates. It validates the requested ref, SHA and migration
before running; it does not deploy or consume provider secrets. Its PR run
passed. PR #1 remains open and review-required, so these additions are not yet
on `main`.

The intended future flow is feature branch → required CI → reviewed PR → main
→ immutable RC tag → staging validation → explicit production approval and
promotion. A push to `main` does not deploy production.

## Branch protection

`main` is protected: PR required, one approval, stale approvals dismissed,
branch must be current, `verify` required, conversations resolved, linear
history required, force pushes disabled and deletion disabled. Administrator
enforcement is intentionally off so the owner retains an emergency recovery
path; emergency changes must still be documented after use.

## Railway source

All nine staging application services were built from GitHub branch
`release/production-hardening` at the exact release SHA:

| Service | Staging deployment |
| --- | --- |
| `convo-database` | `40908ad6-ceba-4bac-8953-a3e755490652` |
| `convo-api` | `9a5d4b51-ac25-44f6-af3b-9c20b0e592a6` |
| `convo-client-demo` | `d969a2a3-c2d9-4760-b70a-30775502efa7` |
| `convo-worker-inbound` | `a7ab407b-8414-4654-856f-5c88003b3840` |
| `convo-worker-interactive` | `3e72463f-4b8e-4219-8245-ee2ef13ab698` |
| `convo-worker-campaign` | `adb8c824-a19c-44d5-b3fe-4535ac162890` |
| `convo-worker-report` | `7888673a-ae12-4166-bf0f-939e5def5ba7` |
| `convo-worker-integration` | `bbce9902-167f-47e5-9fd8-62df2e8bbc2e` |
| `convo-worker-automation` | `e5aa704c-4c0e-472f-ad41-aea16fd8d3a1` |

Every deployment is successful and reports commit
`eac8b262c5b6eadf3289327ce1bbabd40249a7dc`; staging web health and API
instance checks return 200.

### Cross-environment source incident

Railway source association is service-wide. Connecting a service for staging
also created matching production triggers. This unexpectedly ran production
deployment `e464654a-d168-49d6-8460-40502c1490be`, which applied migrations
0026 through 0032, and deployed production web
`e0a80d92-6755-4b8a-9043-65f34f91e19f`. Production API and worker candidates
failed closed; API is not active and its public proxy returns 502. PostgreSQL
remained healthy. No provider activation or production GO was declared.

All nine GitHub source associations were disconnected immediately, preventing
future pushes from retriggering production. Current staging artifacts remain
running and retain commit provenance, but automatic GitHub source deployment is
now deferred. The schema is forward-only; no unsafe rollback was attempted.
Before reconnecting, split staging/production service topology or implement a
release workflow whose Railway target is explicitly staging-only.

## Post-redeploy operator smoke

Against the immutable staging release: login PASS; Inbox PASS; open
conversation PASS; assignment PASS; internal note PASS; label PASS; priority
PASS; second active session PASS; realtime event PASS; resolve PASS; reopen
PASS; audit/history PASS; logout both sessions PASS. Synthetic credentials were
held outside the repository and sessions were revoked by logout. No provider
success is claimed.

## SSE

10/25/50 concurrent streams connected 10/25/50 with setup p95 of 639.0,
432.8 and 797.0 ms respectively. Three rapid 10-client reconnect rounds all
passed. `Last-Event-ID` replay returned two distinct events without duplicate
client-visible identities. An API restart recovered a fresh stream in 21.8
seconds, including deploy restart, and the authenticated session remained
valid. The conservative threshold is 25 live SSE streams per API replica with
reconnect bursts capped at 10; long-duration slow-consumer telemetry remains
unmeasured.

## Performance investigation

A focused 500-request public probe at concurrency 50 measured p95 921.4 ms and
p99 1,008.4 ms; at 100 it measured p95 1,213.4 ms and p99 1,942.3 ms, with zero
errors. Correlated API route duration was p95 2 ms/p99 3 ms, and Railway total
HTTP duration was p95 12 ms/p99 31 ms. This rules out measured route/DB work and
Railway upstream time for that route. The unresolved part is outside the
application between the Cairo generator and Railway's `us-west2` edge
(network/TLS/client connection scheduling). No speculative architecture change
was made; this does not block the 25-operator pilot envelope.

## Worker backlog tests

The existing 200-event inbound backlog drained to zero with no quarantine.
Campaign and automation 100/500/1,000 successful-send tests were not claimed:
the shipped runtime intentionally exposes only the refusing `none` transport
or real Meta, not a scripted success provider. Injecting a fake provider into
staging would violate the release policy. Lease reclaim, dedupe, no-loss and
no-duplicate behavior remain covered by integration/property tests; real
provider backlog throughput is blocked on authorized Meta assets.

## Recovery hardening

Logical isolated recovery remains passing, and the native production recovery
point is bootable. A disposable Railway environment with an independent empty
PostgreSQL volume was created for a safe native-copy restore. Railway rejected
the restore before it started with `OAUTH_INSUFFICIENT_GRANT`; production's
original 1,204 MB volume stayed attached and healthy. The empty scratch
environment was deleted. Therefore an isolated native restore and platform RTO
remain unproven; no proof was fabricated.

## Production preparation

PITR is enabled and bucket-wired; daily and weekly backups and named release
point `80951af4-c581-4d5e-a8df-93dad3ce5091` exist. Health paths, trusted proxy
hops, worker role contracts, `PORT` behavior and release-SHA support are
prepared. Retention growth now has table-family estimates and explicit 10 GiB,
90-day and 2×-daily-rate triggers. Production schema is now 0032 because of the
incident above, but the application/provider release is **not activated**.

## External blockers

- Resend: verified sender and real API key absent; invitation and recovery
  delivery tests blocked.
- Meta: app, system token, WABA, phone number, verify token and authorized
  recipient absent; real inbound/outbound/receipt tests blocked.
- Alerting: named Slack/PagerDuty/Opsgenie/email/webhook destination absent;
  warning and critical delivery tests blocked.

## Remaining risks

Operational release blocker: production schema advanced unexpectedly and
source-driven deploy isolation must be fixed before any new Railway source
association.

Medium: provider flows and backlog throughput unverified; alert delivery
unverified; isolated native restore/RTO unproven; retention policy not yet
approved; long-duration SSE/resource telemetry absent.

Low: migration runner has no advisory lock; exact external network component
behind the 100-concurrency client tail is not decomposed; production recovery
access remains a human single point of failure.

## Next activation command sequence

1. Obtain and validate Resend, Meta and on-call destination values without
   writing them to Git or logs.
2. Resolve Railway environment isolation; verify a staging-only source/release
   mechanism before reconnecting any GitHub trigger.
3. Re-verify tag/SHA, staging health, and that production schema is exactly
   0032; do not rerun migrations as an assumed 0025→0032 step.
4. Create a fresh production recovery point and verify PITR.
5. Run real Resend invitation/recovery, Meta inbound/outbound/receipts and safe
   warning/critical alert tests in the approved environment.
6. Obtain explicit production approval tied to the immutable tag and SHA.
7. Deploy API, web and all workers from that one SHA; migration should be a
   checksum-verified no-op at 0032.
8. Verify every Railway deployment ID, release SHA, `/live`, `/ready`, web
   health and queue metrics.
9. Run the complete authenticated operator smoke and one controlled-recipient
   automation.
10. Monitor queues, provider receipts, logs and alerts; declare pilot GO only
    if every external gate passes.
