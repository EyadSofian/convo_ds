# CONVO — Phase execution prompts

هذه بطاقات تشغيل للـagent المنفّذ، وليست نتائج تنفيذ. المرجع الملزم هو [MASTER-PROMPT.md](MASTER-PROMPT.md). البطاقات تختصر المهمة الحالية دون إسقاط بقية البرنامج. لا تنفّذ كل مراحل المشروع في تعديل ضخم واحد.

## Shared instruction — include with every phase

```text
You are implementing CONVO under MASTER-PROMPT.md. Read the full master once,
then re-read the sections referenced by this phase and the actual repository.
Preserve previous work and confirmed requirements: BOTH multi-tenant SaaS and
single-company self-hosted, official WhatsApp/Messenger/Instagram, granular
roles, a real inbox, broadcasts, API/backend/frontend consistency and Figma-based UI.

Start by reconciling docs/execution/current-task.md with real code/test evidence.
Do not repeat completed scaffolding. Do not silently downgrade required scope.
Break the phase into bounded vertical tasks and execute the next unblocked one.
For each task: requirement IDs → business examples → schema/authorization →
implementation → behavioral tests → visual/security review → recorded evidence.
Use the same domain services for UI, public API, workers and integrations.

Never infer success from a hidden button, mock response, HTTP 202, build pass,
unexecuted test command or generated screenshot. Fix failures; do not skip them.
Run only authorized provider test sends to explicit test assets/recipients.
Record implementation, automated tests, live provider checks and deployment
verification separately. Continue independent work if a live dependency is missing.
Ask only for information needed by the blocked action, while progressing elsewhere.
Do not ask again for routine work already authorized.

Finish each task with changed behavior, paths, exact checks and results, remaining
failures/blockers, and the next task. Write this to docs/execution/current-task.md.
Proceed to the next task when its dependencies are satisfied.
```

## P0 — Repository audit, business contracts and design discovery

**Read:** master sections 0–5, 12–22; inherited research as evidence rather than unquestioned current facts.

```text
Execute P0. Inspect the actual repository, package manifests, schema, API routes,
UI routes, tests, CI and infrastructure. Identify what exists, is partial or is absent.
Never overwrite an application with a new scaffold before this inventory.

1. Create docs/requirements/traceability.md. Enumerate each master requirement,
   including negative behavior, both deployment modes and recovery/permissions.
2. Create docs/product/business-rules.md: actor journeys, nouns, invariants,
   conversation/campaign states, consent, role/scope matrix and commercial limits.
3. Create docs/architecture.md and ADRs: build-vs-extend, stack, module boundaries,
   tenancy/RLS, channel asset ownership, durability, delivery ambiguity, ordering,
   dual deployment, API contracts, retention, provider version and capacity profile.
4. Research primary current Meta references and competitor feature evidence.
   Record source URL/date, observation, decision and unresolved account dependency.
   Verify Instagram login path separately from Facebook Login. Do not copy scopes
   or old versions across APIs. Define a versioned capability matrix per channel.
5. Inspect the primary Figma frame/public preview. Produce design-reference.md,
   screen inventory and tokens with measured vs estimated values distinguished.
   Include original role/channel/campaign screens extending the reference grammar.
6. Define ERD + proposed SQL constraints/indexes, OpenAPI operation inventory and
   request/response examples. Pick the contract source of truth and drift checks.
7. Plan the test harness: real disposable DB/broker, provider simulator, seeded
   tenants/roles, e2e, property/fault/load/visual tests and artifact directories.
8. Record hypotheses for count of companies, concurrency, traffic mix, retention,
   infrastructure cost and region. Do not claim hypothetical load numbers are real.

Internal gate: every required feature has an actor, rule, API/UI/persistence path,
testable outcome and phase. Every uncertain provider ability has a explicit gate.
Write the first P1 task with files, dependencies and exact verification commands.
Then start P1; do not ask the user whether you should begin routine implementation.
```

## P1 — Foundation, deployment modes, users and permissions

**Read:** master sections 2–3, 13, 16–19, 21.

```text
Execute P1 in this order:
1. Pin supported dependencies, strict TypeScript, package scripts, dev containers,
   real migrations, schema validation, formatting/lint/type/build CI and test services.
2. Implement global identities, tenants, memberships, teams, roles, scoped grants,
   sessions, MFA, invitations, recovery and tenant switching. Local auth must use an
   audited library/secure password storage, secure cookies, CSRF protection and
   rate limits. Recovery must not disclose account existence.
3. Apply non-null tenant IDs, composite foreign keys, unique constraints and RLS
   using runtime roles that cannot bypass it. Verify pooled transaction isolation.
4. Implement trusted installation mode and one-time self-hosted bootstrap; SaaS
   provisioning + platform control plane; last-Owner protection and scope ceilings.
5. Implement real People/Roles/Teams/Settings screens, including forbidden actions,
   pending/expired invites, role changes, tenant switch and empty states.
6. Add platform Super Admin with no default chat access. Keep install administration
   and tenant Owner privileges explicit even if one person holds both identities.
7. Implement the global error/idempotency/authorization/API contract infrastructure
   and UI client generation. Sensitive fields are write-only or masked as specified.

Gate: seeded users for every role; allow/deny tests on direct HTTP + RLS; no privilege
escalation through role or API-key creation; two tenants cannot share data; removing
membership revokes active sessions/subscriptions; duplicate bootstrap is harmless;
single-company mode rejects a second company; SaaS supports multiple memberships.
Agent unassigned-queue previews contain only allowed projected fields; full transcript,
notes and attachments require a successful claim/participation in an allowed inbox.
Verify login → invitation → accept → allowed inbox → role change → revoke journeys.
Screens must actually persist through the API and survive refresh/restart.
```

## P2 — First real messaging vertical slice and the Inbox

**Read:** master sections 4–6, 13, 17–20.

```text
Execute P2 in vertical slices:
1. Contacts + scoped external identities, inbox membership and conversation lifecycle.
2. Durable raw webhook journal, signature verification, batch normalization, dedupe,
   outbox relay, broker confirms/acks, dead-letter and safe replay.
3. Official WhatsApp connection onboarding, asset/grant/subscription checks,
   credential refs, health and explicitly labeled provider simulator.
4. Implement inbound → conversation → authorized realtime → timeline using real DB.
5. Implement reply → 202 durable command → send permit → provider outcome → receipt.
   Add outcome_unknown handling BEFORE retrying network failures.
6. Add media quarantine/download access, template-based starter messages when needed,
   private notes, read cursor, claim/assignment, statuses, snooze and reopens.
7. Build the working Figma-based inbox: filters/list/timeline/composer/customer panel,
   saved drafts, failure messages, reconnect/catch-up and empty/offline/forbidden states.

Gate: E2E with real persistence; valid/invalid signature; repeated/batched/reordered
webhooks; two simultaneous agents; failure before/after commit; publish-marker loss;
provider acceptance with lost response; pending draft recovery; private attachment
never sent publicly; tenant-scoped socket catch-up. Visual QA in RTL and LTR.
With authorized test assets, prove real inbound + reply + actual supported receipt.
If assets are unavailable, complete every internal gate and record live verification
as blocked. Do not turn a provider mock into a live-connection success badge.
```

## P3 — Messenger, Instagram, templates and contacts

**Read:** master sections 4–5, 17–20.

```text
Execute P3:
1. Add separate Messenger and Instagram adapters with verified login paths, IDs,
   token/grant rules, windows, capabilities and versioned fixtures. Handle echoes,
   shared-media links, reactions and unsupported payloads according to actual support.
2. Build Channels setup/health/reconnect UX and Template list/editor/preview/sync/status.
   Missing permissions, expired tokens and paused templates are actionable UI states.
3. Implement contacts, typed fields, labels, consent/suppression evidence, segments,
   streaming CSV import with mapping preview + row errors, and authorized async export.
4. Implement merge preview/commit with identity provenance, no cross-company links,
   no fuzzy auto-merge, and a safe way to reverse reviewed links where supported.
5. Add canned replies, macros, mentions, notification preferences and collision warnings.
6. Complete Meta app readiness artifacts: exact implemented permission list, external
   account demonstration, privacy/data-deletion/deauthorization handling and setup guide.
   Authenticate provider callbacks under their actual documented callback contract.

Gate: independent contracts per channel; byte/character boundary cases in Arabic;
no support assumption from one channel copied to another; multi-element payloads;
pagination/reconnect gaps; no consent granted by CSV import; no CRM override of opt-out;
live external-account tests tracked separately from test accounts with application roles.
```

## P4 — Broadcast engine and campaign operations

**Read:** master sections 6–7, 12–13, 18–19.

```text
Execute P4 in this order:
1. Build campaign/version/audience/recipient/attempt/approval/budget records and atomic
   constraints before the campaign wizard.
2. Implement audience preview/snapshot, template revision + language + variables,
   eligibility/exclusion report, schedule/IANA timezone/quiet hours/expiry and dry run.
3. Build the wizard: objective/channel → audience → content → schedule/budget → review.
   Validation/test-send/approval/launch are separate visible actions and API commands.
4. Implement revision-bound approvals and idempotent concurrent launch. POST /launch
   immediately creates the single execution, including when its send time is future.
   Scheduled/running/paused/terminal campaigns cannot change audience/content/schedule/
   budget; cancel and clone for a revised scheduled campaign. Scheduler activates the
   existing bound revision at its due time. Resume/retry retain that execution and ledger.
   Scheduler
   uses trusted UTC time, version checks and durable recovery after restarts.
5. Implement bounded planner/dispatcher queues and hierarchical tenant/channel/traffic
   fairness with shared provider rate limits and conservative budgets.
6. Recheck consent, suppression, template, connection, schedule and stop-version at
   permit time. Define retry-safe vs permanent vs unknown outcomes.
7. Implement pause/resume/cancel barriers, recipient drilldown, failed-only safe retry,
   DLQ replay, cost/usage reconciliation and truthful late-delivery analytics.

Gate: simultaneous launch creates one execution; consent withdrawal after snapshot;
template pause; provider throttles; scheduler/broker/worker restart; unknown send;
cancellation under load; no rerendering approved variables from changed CRM fields;
reservation conservation; stable memory for large audiences; fair interactive latency.
Run synthetic mixed inbox/campaign load at the declared profile and reconcile recipient
ledger totals. Never send a load test to customer phone numbers or real campaign lists.
```

## P5 — Public API, outgoing webhooks and Odoo

**Read:** master sections 8–9, 13, 17–19.

```text
Execute P5:
1. Finalize versioned OpenAPI and operation-level schemas/errors/examples for all
   implemented features. Generate SDK/client and prove first-party UI compatibility.
2. Build scoped service principals, one-time key display, rotate/revoke/expiry and
   credential grant ceilings. Key metadata must never return the secret again.
3. Build webhook subscriptions, timestamp+body HMAC, rotation, retry history,
   stable event IDs, dead-letter/replay and SSRF-safe per-delivery destination validation.
4. Implement async jobs with tenant/job ownership checks and expiring export access.
5. Implement Odoo adapter by actual version/deployment, model field discovery,
   mapping/source-of-truth/conflict policy, external links, cursor and replay.
6. Prove contact sync, idempotent lead creation, permitted order/stage display and
   summary/link update. Display last success, lag and conflicts in the product.

Gate: curl/SDK examples run against real local/staging backend; no undocumented routes;
same-key same-body replay, changed-body conflict; webhook verification/dedupe works;
SSRF/DNS-rebinding rejection; scope ceiling; Odoo timeout after possible remote write
does not create duplicate leads; Odoo downtime leaves inbox operational.
Live Odoo checks require authorized assets; report fixtures and live results separately.
```

## P6 — Routing, automation, SLA and reporting

**Read:** master sections 10, 12–13, 18–19.

```text
Execute P6:
1. Implement business hours/timezones/holidays, routing, agent availability/capacity,
   assignment fairness and overflow. Hard limits must remain true under concurrent claims.
2. Implement versioned first-reply/next-reply/resolution clocks with exact pause/reopen/
   bot-reply semantics. Persist events, not mutable unexplained elapsed counters.
3. Implement typed automation rules, simulator, publish/rollback, run trace, delays,
   dedupe/hop/deadline limits and allowlisted actions with policy checks.
4. Implement CSAT and notifications according to each channel's permitted capabilities.
5. Build reports from real scoped data: inbox backlog, response/resolution/SLA,
   workload, CSAT, campaigns, provider health and usage. Publish each formula,
   denominator, timezone, event-time/observation-time policy and refresh age.

Gate: DST gaps/overlaps, holidays, reopened episodes, duplicate timers/escalations,
two assignment workers, stale availability, workflow loops and retrying side effects.
Reconcile dashboard results with deterministic fixture ledgers. Unsupported read receipts
display unavailable; repeated receipts never inflate success. Exports do not block inbox.
```

## P7 — AI copilot, scoped tools and human takeover

**Read:** master section 11 plus delivery/ownership/authz contracts.

```text
Execute P7 only after reliable messaging and ownership foundations:
1. Implement tenant-scoped source ingestion/versioning/deletion, retrieval and evidence
   display. Enforce source access filters before retrieval results reach a model.
2. Implement suggestions/summaries/classification first; human approves sending by default.
3. Create reproducible Arabic/English golden datasets including dialects, ambiguity,
   conflicting knowledge, missing answers, injection and explicit human requests.
4. Implement typed tools calling authorized domain services, exact-argument approvals,
   idempotency, cost/latency limits, safe fallback and observability with redaction.
5. Implement bot_active/handoff_pending/human_active/bot_paused ownership versions,
   serialized send barrier and cancellation of obsolete generations/queued commands.
6. Enable autonomous intents only after their eval gates; expose tool/knowledge/budget/
   channel settings and emergency stop without coupling the inbox to AI availability.

Gate: one company cannot retrieve another's content; injection cannot broaden tool scope;
no unrestricted SQL/HTTP/code; expired approval fails; LLM timeout gives visible fallback;
AI result after takeover cannot receive a send permit; an already-in-flight request is
accounted for without claiming it can be recalled. Record actual eval scores and costs.
```

## P8 — Production, self-hosted packaging and release proof

**Read:** master sections 12–13, 16–17, 21.

```text
Execute P8:
1. Complete enterprise SSO, retention/deletion, audit, secrets/key rotation/recovery,
   accessibility review, dependency/secret/security scans and operational kill switches.
2. Build immutable API/worker/realtime/web images, production env schema, migration
   tooling, readiness/liveness, graceful drain and deterministic rollback procedures.
3. Deliver SaaS/HA Helm and infrastructure configuration with Postgres PITR, broker
   durability, backups, metrics/alerts and capacity-aware resource ceilings.
4. Deliver separate hardened single-host self-hosted Compose installer; never reuse
   insecure development settings. Also document self-hosted HA. Bootstrap disables
   itself after Owner creation. No dependency on SaaS billing/telemetry for core operation.
5. Execute install/upgrade/restart/backup/off-host restore scenarios for both modes,
   documenting single-host downtime and HA-profile failover separately. Every restore
   starts with outbound recovery_hold outside the restored snapshot. Reconcile or
   quarantine missing-interval opt-outs and accepted sends before releasing scopes;
   test records written after the recovery point, not only lossless full backups.
6. Exercise agreed synthetic load/soak/fault profiles on suitable disposable/staging
   infrastructure. Record offered/achieved rates, errors, percentiles, resources,
   integrity reconciliation and provider simulator boundary.
7. Deploy to the explicitly authorized target, run migrations, verify frontend deep
   links/TLS/API/realtime/worker/ingress, and perform authorized channel smoke tests.
   If production authorization/credentials are missing, finish the deployable release
   package first and request only the remaining concrete step.

Release gate: no unresolved critical behavior defect or exploitable high/critical security
finding; all required internal tests passed; both deployment-mode reports complete;
live-provider checks evidenced or explicitly blocking the relevant release claim;
restore/upgrade/load evidence; operator runbooks; screenshots; OpenAPI; traceability;
remaining external dependencies stated. Do not call the product shipped from a build pass.
```

## P9 — Additional channels and capabilities

```text
Preserve an extension registry for web widget, email, SMS, Telegram, LINE, help center,
calling, WhatsApp Flows and catalogs. A generic adapter is not an implemented channel.
When the user prioritizes one, promote it to required scope with a numbered subphase:
official-source discovery → capability/policy contract → secure connection UX → adapter
and normalization → business UI → schema/security/failure tests → authorized live check.
Specify inbound/outbound, initiation rules, attachments, receipts, identity, consent,
onboarding, rate limits, credential lifecycle, history and deployment dependencies.
Do not advertise unsupported capability parity or infer that email/SMS use WhatsApp rules.
```

## Resume prompt — for a new session or a smaller-context agent

```text
Continue CONVO from MASTER-PROMPT.md and docs/execution/current-task.md.
First inspect the actual repository and the latest test evidence. List the last verified
task, current task, exact blockers and next unblocked dependency. Read the relevant
phase card and master sections before editing. Preserve both deployment modes and
all requirement IDs. Do not restart, replace the stack or regenerate finished screens.
Execute the next bounded vertical task; record real results and continue.
```

## Task report template — never prefill passing results

```text
Task / phase / requirement IDs:
Source revision and environment:
Business behavior delivered:
Files / migrations / API operationIds / UI screens:
Checks actually run, exit codes and evidence paths:
Coverage/exclusions and observed failures:
Provider-live verification:
Deployment-mode verification:
Open dependency, exact input required and independent work continued:
Next task and its entry/exit conditions:
```
