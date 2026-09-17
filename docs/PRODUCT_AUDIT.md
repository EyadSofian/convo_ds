# Digital School Operations Platform — Product Audit

Audit date: 2026-09-17  
Source of truth: `digital-school-requirements.json`, the approved continuation brief, the current repository, migrations `0001`–`0025`, API contract, browser application, tests, and deployment runbooks.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED` | Production code, persistent model, permission boundary and meaningful automated evidence exist. |
| `PARTIALLY_IMPLEMENTED` | A usable core exists, but one or more approved behaviours or production adapters are absent. |
| `MISSING` | No production implementation exists. |
| `BROKEN` | An implementation exists but does not meet its approved contract. |
| `NEEDS_CLIENT_CONFIGURATION` | Product support exists, but client assets, credentials or a business decision are required. |
| `NOT_APPLICABLE` | Explicitly outside the approved product. |

## Executive finding

The repository is a substantial production foundation rather than a finished client product. Tenant isolation, authenticated sessions, permission evaluation, the inbox lifecycle, manual routing, channel ingress, durable outbound dispatch, realtime projections, typed customer metadata and the main campaign execution path are implemented and tested. The remaining delivery risk is concentrated in configurable business operations: reusable audiences, saved views, automatic labels and routing, recurring schedules, automation, general operational reporting, real service email and live provider credentials.

The current purple `CONVO` presentation is also inconsistent with the supplied Digital School identity. It is a product-brand defect, not a request to turn the application into a marketing website.

## Capability audit

| Area | Status | Current evidence | Gap / required change | Primary impact |
| --- | --- | --- | --- | --- |
| Authentication and sessions | `IMPLEMENTED` | Argon2id login, opaque server sessions, CSRF, rate limits, session listing/revocation, recovery challenge, generic anti-enumeration response | Add production email delivery and optional activation/verification policy | API/config/email |
| Invitations and password recovery | `PARTIALLY_IMPLEMENTED` | Secure invitation and recovery workflows exist | Default delivery adapters only log redacted events; no SMTP/Resend adapter, templates or delivery evidence | API/config/database |
| Users, teams, roles and permissions | `IMPLEMENTED` | Configurable roles, permission catalogue, team scopes and server authorization engine | Configure client teams and final grants during onboarding; do not encode department names in code | Client data/config |
| Team conversation restriction | `NEEDS_CLIENT_CONFIGURATION` | Scoped authorization is supported | Client left `access.restrict_conversations_by_team` unanswered | Policy only |
| Inbox and conversation lifecycle | `IMPLEMENTED` | Open/reopen/close/snooze/wake, unread state, notes, priority, timeline and customer panel | Attachments are readable from provider events but operators cannot upload/send files | API/UI/storage |
| Manual assignment, reassignment and handoff | `IMPLEMENTED` | Assignment history, offered handoff, accept/decline/cancel/expiry and fencing | None for approved manual flow | — |
| Auto assignment and team routing | `MISSING` | Permission and manual routing foundations exist | Add ordered rules using the shared condition model, eligible-agent strategy, capacity and auditable decision history | DB/API/worker/UI |
| Business hours, escalation and SLA | `MISSING` | Durable jobs and conversation lifecycle provide foundations | Add calendars, timezone-aware business windows, SLA policies, breach jobs and escalation actions | DB/API/worker/UI |
| Supervisor intervention | `PARTIALLY_IMPLEMENTED` | Supervisor-scoped read and routing capabilities exist | Final client visibility policy is needed; add explicit takeover/escalation action and report evidence | Policy/API/UI |
| Conversation filters | `PARTIALLY_IMPLEMENTED` | Status, ownership, queue mode, priority, channel and portions of metadata filtering exist | Complete one composable server query for team, agent, labels, name, phone, date range, last message date, unread, unassigned, custom fields and Campaign Name | API/DB indexes/UI |
| Saved Views | `PARTIALLY_IMPLEMENTED` | Persistent private/team/workspace views, validation, authorization and CRUD API exist | Add operator UI and bind views to the completed server filter query | UI/API |
| Labels | `IMPLEMENTED` | Tenant catalogue, assignment/removal, audit and filters | None for manual labels | — |
| Automatic label rules | `MISSING` | No rules engine | Add ordered, enabled rules using the shared condition evaluator and idempotent label actions | DB/API/worker/UI |
| Custom customer fields | `IMPLEMENTED` | TEXT, NUMBER, DATE, BOOLEAN, SELECT, MULTI_SELECT, EMAIL and PHONE definitions/values are enforced in domain and PostgreSQL | Reuse all types in later audiences, automation and reports | — |
| Customer / identity separation | `IMPLEMENTED` | `contacts` and scoped `contact_identities` are separate; identities are not inferred or silently merged | Add reviewed merge only if later approved | — |
| Customer profiles and history | `IMPLEMENTED` | Profile, identities, consent, suppressions, metadata and conversation timeline exist | Operator attachment upload remains separate gap | UI/API |
| Reusable dynamic audiences | `PARTIALLY_IMPLEMENTED` | Reusable definitions, shared validated conditions, versioning and CRUD API exist | Add preview/count UI and execution-time compilation into campaign snapshots | API/UI/worker |
| Campaign authoring and execution | `PARTIALLY_IMPLEMENTED` | Draft/revision, validation, revision approval, test send, launch, pause/cancel, recipients, retries and reporting exist | Add explicit submit-for-approval state/metadata, reusable audiences and recurrence | DB/API/UI/worker |
| Campaign approval | `PARTIALLY_IMPLEMENTED` | Revision-bound approval and separation-of-duty checks exist | Add `requestedBy/requestedAt` and a visible pending approval queue | DB/API/UI |
| One-time scheduled campaign | `IMPLEMENTED` | Durable execution schedule and campaign worker exist | None | — |
| Recurring scheduled campaign | `MISSING` | No recurrence definition or next-run calculator | Add daily/weekly/monthly/custom recurrence, timezone, range, enabled/paused, next/last run and durable materialization | DB/domain/worker/UI |
| Automation engine | `MISSING` | Durable queue patterns and auditable services exist | Add trigger/action definitions, shared conditions, execution history, idempotency, retry and safe webhook action | DB/domain/API/worker/UI |
| Campaign reports | `IMPLEMENTED` | Performance, audience, delivery, failure, export and date/channel/campaign scopes exist | Extend to reusable audience names and recurring run dimensions | API/UI |
| General operational reports | `MISSING` | No general report service | Add volume, open/closed, agent/team workload, response time, customer/audience, labels and custom report builder | DB/API/UI |
| Resolution-time report | `NEEDS_CLIENT_CONFIGURATION` | Lifecycle timestamps make it calculable | Client left the metric unanswered; define resolved event, pause treatment and business-hour clock | Policy |
| WhatsApp, Messenger, Instagram | `PARTIALLY_IMPLEMENTED` | Signed webhook adapters, normalization, capability-specific policy and durable dispatch exist | No live Graph transport or client Meta app credentials | Provider/config |
| Website Chat and Custom Channel | `PARTIALLY_IMPLEMENTED` | Signed self-hosted ingress and channel contracts exist | Finish install UI/snippet distribution and production connectivity verification | API/UI/config |
| TikTok / additional channels | `MISSING` | Versioned custom-channel escape hatch exists | Build a capability-specific adapter only after API access and supported events are confirmed | Provider/DB/API/UI |
| Realtime | `IMPLEMENTED` | Authorized event projection, cursors, reconnect and durable relay model exist | Production broker still requires configuration | Config/infra |
| Durable jobs | `PARTIALLY_IMPLEMENTED` | PostgreSQL queues/outbox, attempts, recovery, fencing and separate workers exist | Automation/SLA/recurrence queues are absent; production broker adapter is unconfigured | DB/worker/config |
| Database and tenant security | `IMPLEMENTED` | Forward-only checksummed migrations, transaction-scoped tenant context, forced RLS and tenant-qualified foreign keys | New modules must preserve the same rules | — |
| HTTP/API security | `IMPLEMENTED` | Session gate, CSRF, request IDs, typed errors, authorization, anti-enumeration and idempotency | Add structured production logger and security headers review | API/ops |
| Railway production topology | `PARTIALLY_IMPLEMENTED` | Docker build, API/web/workers, one-shot migration and runbook exist | Add provider/email/broker assets, health probes, backups, recovery drill and final smoke checks | Infra/config |
| Responsive operator UI | `PARTIALLY_IMPLEMENTED` | Desktop layouts, dark/light themes, accessibility and visual tests exist | Complete mobile/tablet responsive behaviour for new screens and fix the overly sparse unauthenticated state | UI/tests |
| Digital School brand | `PARTIALLY_IMPLEMENTED` | Official logo, blue/yellow/charcoal/powder tokens, IBM Plex hierarchy, metadata and contrast checks are applied | Review every visual baseline and extend the identity to service email/export artifacts | UI/assets/tests |

## Architecture consequences

1. Keep PostgreSQL as the system of record and durable scheduler. The project already has transactional queues, outboxes, attempts and fencing; introducing Redis or a second scheduler would duplicate guarantees without a current requirement.
2. Add one versioned condition language for saved views, audiences, routing rules, automatic labels and automation. Each consumer may expose only its permitted fields and operators, but parsing and evaluation must share the same core.
3. Preserve execution evidence. Dynamic audiences are re-evaluated immediately before an execution and then frozen into that execution’s snapshot. The definition stays dynamic; an already-started delivery set does not mutate.
4. Keep authorization permission-based. Client department names and final role names are data configured during onboarding.
5. Keep provider capabilities explicit. “Additional channel” does not imply that TikTok, WhatsApp and Instagram support the same message types, receipts, templates or windows.

## Delivery sequence

1. Shared condition contract, EMAIL/PHONE custom fields, saved views and reusable audiences.
2. Automatic label rules and configurable routing rules.
3. Campaign submission metadata, dynamic execution snapshots and recurrence.
4. Automation definitions, scheduler, execution ledger and webhook safety.
5. Service email adapter and notification templates.
6. Business hours, SLA, escalations, attachments and supervisor takeover.
7. General reports and report authorization.
8. Digital School product branding and responsive UI across every state.
9. Provider configuration, Railway hardening, backup/recovery and production acceptance.

## Definition of production-ready

Production readiness requires all migrations applied, no demo adapter enabled, real email and provider adapters configured, secret rotation documented, broker/realtime topology verified, backups and restore tested, health probes green, browser smoke tests against the deployed URL, and every remaining `NEEDS_CLIENT_CONFIGURATION` item either supplied or explicitly deferred in writing.
