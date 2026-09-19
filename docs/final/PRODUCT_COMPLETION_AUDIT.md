# CONVO product completion audit

Audit date: 2026-09-19  
Audited source: GitHub `main` at `3d5a2f9ef86c9f24c1d91e84f3ceda8f88e6d406`  
Database high-water mark: `0032_automation_execution.sql`

This document is a handover decision record, not a marketing checklist. A green
automated test proves the implemented contract; it does not prove that a third
party account, sender, phone number, recipient, or alert destination is live.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `COMPLETE` | The approved product path exists, is persisted and authorized, and has meaningful automated evidence. |
| `PARTIAL` | A useful production implementation exists, but a named product surface or adapter is unfinished. |
| `MISSING` | The capability is not implemented. |
| `LIVE_TEST_REQUIRED` | The adapter exists, but no authorized live-provider proof is available. |
| `CLIENT_INPUT_REQUIRED` | A client-owned credential, policy, roster, domain or metric definition is required. |
| `POST_MVP` | Explicitly suitable for a later scope; it is not represented as delivered. |

## Executive decision

CONVO is source-handover ready as a substantial operator platform: the build is
reproducible, the database and tenant boundary are mature, and the core inbox,
contact, campaign, automation, reporting, security and responsive UI paths have
strong automated evidence. It is **not provider-live production ready**. Meta,
Resend and an alert destination remain external gates, and Messenger/Instagram
outbound plus an installable website-chat widget are not complete adapters.

The incomplete product features do not all have the same release consequence.
Operator attachments, saved-view UI and operational reporting are internal
backlog items. Automatic routing, business hours, SLA and escalation require
both implementation and client policy. CRM, Telegram, TikTok and recurring
campaigns are post-MVP unless the owner explicitly changes the acceptance scope.

## Capability review

| Area | Status | Evidence in the source | Remaining work / release consequence |
| --- | --- | --- | --- |
| Authentication and sessions | `COMPLETE` | Argon2id login, opaque hardened sessions, CSRF, rate limiting, session listing/revocation, anti-enumeration and recovery challenges | Live email is separately gated. |
| Invitations and password recovery | `LIVE_TEST_REQUIRED` | Durable email outbox, localized templates, one-time invitation/reset tokens, token reuse denial and session revocation | Verify a Resend sender, invitation delivery and recovery delivery. |
| Users, teams, roles and permissions | `COMPLETE` | Seven-role baseline, configurable grants, team/resource scopes and server-side authorization | Client roster and final grants are onboarding data, not code. |
| Tenant isolation | `COMPLETE` | Forced RLS, transaction-scoped tenant context and tenant-qualified foreign keys | Preserve these invariants in every future migration. |
| Inbox and conversation lifecycle | `COMPLETE` | Queue, claim, assignment, priority, snooze/wake, resolve/reopen, unread state, history and realtime refresh | No release-blocking core gap. |
| Inbox search and filters | `PARTIAL` | Server-backed queue modes, status, ownership, priority, channel, label and metadata filters exist | Complete the single composable query for every requested person/team/date/message/custom-field dimension. |
| Internal notes | `COMPLETE` | Separate note model, author-only edit/delete policy and retained tombstone/audit behavior | Mentions and note search are optional later enhancements. |
| Manual assignment and handoff | `COMPLETE` | Direct assignment, unassignment, collaborators and offered handoff with accept/decline/cancel/expiry and version fencing | No core gap. |
| Automatic routing | `MISSING` | Manual routing and a shared condition language provide foundations | Implement ordered auditable rules only after client team/capacity policy is approved. |
| Business hours, SLA and escalation | `CLIENT_INPUT_REQUIRED` | Lifecycle timestamps and durable scheduling primitives exist | Metric clock, calendars, holidays, targets and recipients must be defined; engine/UI remain unimplemented. |
| Labels and priority | `COMPLETE` | Label catalogue, assign/remove history, filters and versioned priority update | Automatic label rules remain missing. |
| Automatic label rules | `MISSING` | Shared bounded condition language exists | Add ordered rules and idempotent label actions if retained in acceptance scope. |
| Saved views | `PARTIAL` | Tenant-isolated private/team/workspace CRUD API and validated conditions | Complete operator UI and full filter binding. |
| Contacts and identities | `COMPLETE` | Scoped identities, exact matching, identity history, consent and suppression evidence, custom fields | Manual import/create and reviewed merge are not implemented; inbound-created contacts are the current product rule. |
| Custom fields | `COMPLETE` | Text, number, date, boolean, select, multi-select, email and phone types enforced in domain and PostgreSQL | Reuse consistently in future reporting/rules. |
| Contact search/history | `COMPLETE` | Tenant-scoped directory/profile reads, channel identity history and conversation history are server-backed | Manual contact creation/import is outside the current inbound-created contact rule. |
| Operator attachment send/upload | `MISSING` | Inbound attachment metadata can be normalized and displayed; outbound transport explicitly refuses unsupported attachment send | Define storage, malware/MIME/size policy and retention before implementation. |
| Campaign authoring | `COMPLETE` | Drafts, immutable revisions, validation, clone, approval, test-send and recipient selection surfaces | Reusable audience UI remains partial. |
| Campaign execution | `COMPLETE` | One-time scheduling, durable recipient jobs, pause/cancel, retry, delivery reconciliation and immutable evidence | Live provider execution is separately gated. |
| Campaign approval UX | `PARTIAL` | Revision-bound approval and separation of duties are enforced | Add explicit submitted/pending metadata and a dedicated approval queue if required. |
| Recurring campaigns | `POST_MVP` | Automation schedules exist, but campaign recurrence is not a completed campaign feature | Define cadence/timezone semantics before adding it. |
| Campaign reports and export | `COMPLETE` | Real execution-backed performance/audience/delivery/failure views and asynchronous safe CSV export | Live data appears only after authorized provider use. |
| Operational/team/agent reports | `MISSING` | Campaign reporting only | Agree KPI definitions, then add workload, response and resolution views; do not infer client metrics. |
| Automation definitions | `COMPLETE` | Versioned definitions, 19 presets, 24 triggers and ten ordered step types | Scope any additional advertised actions explicitly. |
| Automation execution | `PARTIAL` | Durable event/schedule intake, recipient planning, leases, retries, idempotent action evidence and receipt reconciliation | Rich execution-detail UI, optional approvals/test-runs and live provider evidence remain. |
| Realtime/SSE | `COMPLETE` | Tenant-authorized projections, cursor/replay/reset, reconnect and dedupe behavior | A broker is optional; monitor reconnect behavior under the target deployment. |
| WhatsApp inbound | `LIVE_TEST_REQUIRED` | Signature verification, raw journal, normalization, dedupe and receipts | Authorized Meta app, WABA, phone and real signed event required. |
| WhatsApp outbound | `LIVE_TEST_REQUIRED` | Real Meta Graph transport, template sync, dispatch fencing and provider IDs | Controlled test recipient and live sent/delivered/read evidence required. |
| Messenger and Instagram inbound | `LIVE_TEST_REQUIRED` | Signed Meta webhook adapters and channel-specific normalization/policies | Verify actual authorized assets and event subscriptions. |
| Messenger and Instagram outbound | `MISSING` | No live outbound transport is claimed | Build channel-specific Graph transports before promising two-way live messaging. |
| Website chat and custom channel ingress | `PARTIAL` | Signed HMAC ingress, replay protection, origin allowlist, normalization and dedupe | Production connectivity test and credential provisioning are required. |
| Installable website-chat widget | `MISSING` | No finished customer-facing embed package/snippet | Productize only if it is part of the contracted MVP. |
| Channel connection UX | `PARTIAL` | Admin catalogue distinguishes configured/unavailable states and keeps secrets server-side | Provider identity, last verification and actionable degraded states need live adapter data; technical IDs should move behind advanced admin detail. |
| Email / Resend | `LIVE_TEST_REQUIRED` | Resend adapter, durable outbox, retries and fail-closed production validation | Verified sender, key, delivery and link acceptance/reset evidence required. |
| Alerting | `CLIENT_INPUT_REQUIRED` | Alert rules and runbook exist | Name and configure Slack/PagerDuty/Opsgenie/email/webhook destination; run safe warning and critical tests. |
| CRM / Odoo | `POST_MVP` | No live CRM adapter is part of this release | Require vendor contract, auth, mappings and conflict ownership before work. |
| Telegram / TikTok / other channels | `POST_MVP` | UI accurately marks unavailable; versioned custom-channel boundary exists | Confirm approved API product and capabilities before an adapter is designed. |
| API and HTTP security | `COMPLETE` | Authorization, CSRF, typed errors, request IDs, idempotency, signed webhooks and dependency audit | Continue release-time security checks. |
| Profile, settings and session security | `COMPLETE` | Authenticated profile context, active-session listing/revocation and honest unavailable states replace demo settings | Client-specific organizational settings remain onboarding data. |
| Health, logs and monitoring | `PARTIAL` | Structured logs, request IDs, `/live`, `/ready`, web `/healthz`, queue evidence and alert rules exist | A named alert destination and live warning/critical delivery proof are absent. |
| Backups and recovery | `PARTIAL` | Logical dump/restore evidence, recovery tests/runbook, production PITR and scheduled backups are documented | Native restore into an isolated Railway scratch target remains permission-blocked; each client host needs its own verified policy. |
| Database migrations and recovery logic | `COMPLETE` | 32 checksummed forward migrations, advisory migration lock, real pg_dump/restore tests and recovery runbook | An isolated native Railway snapshot restore remains platform-permission blocked. |
| Responsive UI / RTL / accessibility | `COMPLETE` | Desktop, tablet and mobile matrices; RTL/LTR, dark/light, keyboard and automated a11y/visual coverage | Future features must extend the same matrices. |
| UI states and operational styling | `COMPLETE` | Navigation, inbox, contacts, people, channels, campaigns, automation, reports, settings, auth, loading/empty/error/denied/disabled states and dialog/form primitives use the restrained brand layer | No new visual defect was found that justified another redesign. |
| Source deployment portability | `COMPLETE` | Node 22/pnpm lockfile, one Dockerfile, role-selected process artifact, generic environment contract and PostgreSQL source of truth | Provider and infrastructure credentials stay outside the archive. |

## Automated verification of merged source

The audit used a fresh clone, not prior build output. The following all exited
successfully: frozen install, lint, typecheck, build, unit (1,851), integration
(581), property (5), contracts, security (378 plus a clean production dependency
audit), coverage (2,437 tests at 100% measured statements/branches/functions/
lines), end-to-end (296), accessibility (43), visual (38), and progress portal
tests (7 data tests plus 8 browser tests).

## Handover decision

`SOURCE_HANDOVER_READY_PROVIDER_ACTIVATION_BLOCKED`

The source, schema, build, tests and operating documentation can be handed over.
Do not declare customer messaging production-ready until the live gates in the
integration matrix pass. Do not deploy a production migration or enable
provider workers merely to make a checklist look complete.
