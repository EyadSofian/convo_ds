# ADR-0014 — Single-region HA, asynchronous DR, and a recovery hold outside the snapshot

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P8 release claims
- **Requirement IDs:** DEP-07..DEP-12, DR-01, DR-02, MODE-13, MODE-14

## Context

Two very different operating contracts share one product: a single-host self-hosted install (one failure domain) and a SaaS HA topology. The dangerous failure is not the outage; it is what the system does when it comes back with a few minutes of data missing.

## Decision

**Topology.** Start single-region HA: stateless `api`/`ingress`/`realtime` replicas; separately provisioned worker pools with resource ceilings; Postgres HA with PITR and connection pooling; broker quorum across failure domains; object storage with redundancy and versioning; secrets under KMS or a self-hostable key-management arrangement. Multi-region **writes** require a confirmed requirement and their own ADR — we will not create split-brain delivery paths for a hypothetical.

**Honest targets.** Initial disaster RPO ≤5 min and RTO ≤60 min, verified by an actual restore drill. With asynchronous replication we do **not** claim RPO = 0. The single-host self-hosted profile has **no automatic host failover**; it publishes its own separately measured downtime and restore results and never inherits SaaS HA numbers.

**The recovery hold.** Every restore begins with an installation-level `recovery_hold` that disables **all** outbound permits — campaigns, human replies, AI, automations, CRM writes — enforced through the restore/deployment control path **outside** the restored application snapshot. Restored `active` rows must not auto-restart side effects. Authenticated inbound journaling and read-only diagnosis remain allowed where safe.

**Reconciliation before release.** Record the recovery point, last known healthy point, affected assets and the uncertainty interval. Recover or reconcile suppression, accepted attempts, idempotency records, approvals and usage from intact WAL/replicas/independent journals. Use provider reconciliation only where the API genuinely supports the needed evidence. **Absence of a record in an old snapshot is not proof** that a message was never sent or that a recipient never opted out. Unresolved recipients/attempts are quarantined and stay ineligible for outbound pending an authorized operator decision; a previous consent snapshot alone cannot clear an uncertain opt-out. Release scopes only with evidence they are unaffected. Persist a new recovery/dispatch epoch, invalidate old permits, account for in-flight work, then resume workers. Publish residual loss and uncertainty explicitly.

## Consequences

- Recovery is slower and more manual than "start everything and hope". That is the trade we are making on purpose.
- The `recovery_hold` mechanism must live in deployment tooling, which means it is tested as part of the deploy path, not the app suite.

## Alternatives rejected

- **Multi-region active/active from day one.** Rejected: split-brain delivery, no confirmed requirement.
- **Auto-resume after restore.** Rejected: this is precisely how stale-consent sends and duplicate campaign sends happen.
- **Claiming RPO = 0 with async replication.** Rejected as false.

## How this is verified

- DR-01: restore DB + media, replay residual work; measure RPO/RTO; outbound held until the gate.
- DR-02: create an opt-out **and** an accepted send *after* the recovery point, then restore → no stale-consent send, no blind resend, interval reconciled or quarantined.
- Single-host: measured downtime and restore time published separately from the HA profile.
