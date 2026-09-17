# Release manifest

Status: **release candidate; production NO-GO pending external configuration**
Date: 2026-09-17

## Source and schema

| Item | Value |
| --- | --- |
| Branch | `release/production-hardening` |
| Starting SHA | `2aa0881e4b7221f5a37ec2fcff8ec9bd4e46989a` |
| Release commit | the commit annotated by `v1.0.0-rc.1` |
| Commit message | `Complete CONVO core production hardening` |
| Release tag | `v1.0.0-rc.1` |
| Migration high-water mark | `0032_automation_execution.sql` |
| Staging migration count | 32 |
| Production migration count | 25 (candidate intentionally not promoted) |

The final SHA and post-release staging deployment identifiers are captured by
the tag and final release report. No Git remote is configured in this checkout,
so remote push is externally blocked.

## Railway ownership

Project `09c4e61b-b956-466f-bb21-9b32fc4527f5`; staging
`6c7d3ce1-db61-40fd-9cf7-bffac954eda5`; production
`ea473c79-c29e-4aab-91c4-e48f606dc057`.

Every staging application deployment is built from a clean checkout of the
tagged commit. `CONVO_RELEASE_SHA` records the exact source SHA on each service;
deployment IDs and readback are retained in the final release report.

## Production decision

No candidate application or migration is promoted without authorized Meta and
Resend assets and a named alert destination. Production platform safety
configuration (PITR, backup schedules, health paths, trusted proxy setting and
worker variable contracts) may be prepared independently and is documented in
the environment matrix.
