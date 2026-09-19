# Release manifest

Status: **release candidate; production NO-GO pending external configuration**
Date: 2026-09-17

## Source and schema

| Item | Value |
| --- | --- |
| Branch | `release/production-hardening` |
| Starting SHA | `2aa0881e4b7221f5a37ec2fcff8ec9bd4e46989a` |
| Release commit | `eac8b262c5b6eadf3289327ce1bbabd40249a7dc` |
| Commit message | `Complete CONVO core production hardening` |
| Release tag | `v1.0.0-rc.1` |
| Migration high-water mark | `0032_automation_execution.sql` |
| Staging migration count | 32 |
| Production migration count | 32 (unexpected shared-source trigger on 2026-09-18; see incident below) |

The remote `main`, `release/production-hardening` and dereferenced
`v1.0.0-rc.1` tag all resolve to the release commit. A clean clone verified the
same default-branch SHA and passed the complete install and test gate.

## Railway ownership

Project `09c4e61b-b956-466f-bb21-9b32fc4527f5`; staging
`6c7d3ce1-db61-40fd-9cf7-bffac954eda5`; production
`ea473c79-c29e-4aab-91c4-e48f606dc057`.

Every current staging application deployment was built by Railway from the
GitHub release branch at the tagged commit. `CONVO_RELEASE_SHA` records the
exact source SHA on each service; deployment IDs and readback are retained in
the continuation report.

Railway source association is service-wide, not staging-only. Connecting it
created production triggers and advanced the production database from 0025 to
0032 before the migration job's cross-environment effect was visible. Release
web deployed; API and workers failed closed. Source triggers were then
disconnected from all nine application services. The successful staging
deployments remain running and retain immutable Git metadata, but automatic
GitHub deployment is deferred until environment isolation is implemented.

## Production decision

Customer/provider activation remains forbidden without authorized Meta and
Resend assets and a named alert destination. The schema promotion happened
unintentionally as documented above; it does not satisfy or waive those gates.
Production platform safety configuration is documented in the environment
matrix.
