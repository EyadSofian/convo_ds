# ADR-0002 — Both deployment modes from one artifact

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P1
- **Requirement IDs:** MODE-01..MODE-17

## Context

The product must serve multi-tenant SaaS *and* single-company self-hosted. The tempting shortcut — "self-hosted has one company, so we can skip tenant scoping" — destroys the isolation model and guarantees that the two modes diverge.

## Decision

One source, one schema, one API contract, one image set. `DEPLOYMENT_MODE ∈ {saas, self_hosted_single}` is **trusted installation configuration**, read from validated environment at boot only.

- Tenant scoping, RLS, permission checks and scoped credentials are **identical** in both modes. Single-company mode has exactly one tenant row; it does not have "no tenant".
- Tenant resolution in `self_hosted_single` comes from installation config server-side. A caller supplying a tenant header, query or Host never changes it, and provisioning refuses to create a second company.
- Mode changes only *UI affordances* (hide tenant switcher) and *operational contracts* (single-host has no automatic host failover; it must publish its own measured downtime and restore results and must never inherit SaaS HA claims).
- Self-hosted must open its inbox with zero calls to any SaaS billing or telemetry service.

## Consequences

- Slightly more code in single-company mode than a "simple" single-tenant app. Accepted: this is what prevents two divergent products.
- Every feature must be tested in both modes; the release report is produced twice from the same revision (MODE-17).
- Moving a company between modes is an explicit export/import operation (MODE-16), never a flag flip on a live database.

## Alternatives rejected

- **Two codebases / a "lite" edition.** Rejected: guaranteed drift, doubled security surface.
- **Mode inferred from tenant count at runtime.** Rejected: makes a security-relevant decision depend on mutable data.

## How this is verified

- Boot-time config schema test; invalid value fails startup.
- Negative tests: tenant header/query/Host injection; duplicate bootstrap; second-company creation in single mode.
- Two release reports from one immutable revision.
