# ADR-0010 — Odoo integration: version-detected adapter, idempotent writes, no distributed transaction

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P5 CRM work
- **Requirement IDs:** CRM-01..CRM-12

## Context

Odoo 17 exposes its supported external RPC interface; Odoo 19 introduces JSON-2. Deployments differ (Odoo Online vs self-hosted) and *subscription restrictions on Odoo Online are not the same as constraints on a self-hosted installation*. Service-account permissions and installed modules vary per customer, so field availability cannot be assumed.

## Decision

**Version- and deployment-detected adapter.** On connection test, discover the Odoo version and deployment, select the RPC dialect, then **discover models and fields** and probe the service account's actual permissions. Missing permissions surface as actionable errors, not as silent skips.

**No distributed transaction.** There is no atomic write across CONVO and Odoo. Every remote write carries a stable operation business key; external links are `(tenant_id, integration_id, model, external_id)` with a unique constraint. On an ambiguous outcome (timeout after a possible write), the worker **reconciles by the external key** and, if reconciliation is not possible, records the uncertainty — it never blindly creates a second lead.

**Sync.** Use reliable events where available; otherwise an incremental cursor on `(write_date, id)` with deliberate overlap and dedupe. Loop prevention via origin/version/correlation markers. Handle pagination, deletions, permission changes, schema drift, 429/5xx/timeouts and expired credentials as first-class states.

**Isolation of failure.** Odoo downtime never blocks the inbox. The integration circuit-breaks, shows stale/last-sync/lag/conflict state in the product, and queues work for later.

**Consent is ours.** CONVO's suppression and consent records are authoritative for sending. A stale CRM import can never overwrite them.

**Privacy scope.** Conversation summaries/links written back to Odoo follow a documented field/note operation and an explicit scope; private notes are excluded by policy.

## Consequences

- The connection test is heavier than a ping. It is also the thing that makes the integration honest.
- A generic connector contract (CRM-12) falls out of this design, so a second CRM does not require core changes.

## Alternatives rejected

- **Assume Odoo 17 XML-RPC everywhere.** Rejected: breaks on 19 and on restricted deployments.
- **Fire-and-forget writes with retry.** Rejected: duplicate leads.
- **Treat CRM as source of truth for consent.** Rejected: violates I8.

## How this is verified

- CRM-01 fault test: timeout after a possible remote write → exactly one lead, or a recorded unknown.
- CRM-02: bidirectional update, schema drift, deleted object → no loop, mapped conflict visible.
- Downtime test: inbox fully operational with the integration broken.
- `Live` stays `blocked_no_asset` until an authorized Odoo instance is supplied; fixtures and live results are reported separately.
