# CONVO — Execution ledger

This is the handoff file. Read it first, then [traceability.md](../requirements/traceability.md), then the relevant phase card in `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md`.

---

## Last completed task — P1-T18 (asynchronous campaign report export)

**Task / requirement IDs:** CMP-23 implemented; CT-10 and REP-01 advanced; UX-09 advanced.

### Behavior delivered

**The request no longer generates a file.** `POST T/reports/campaigns/exports` authorizes `report.read`, binds the job to the requesting membership and returns 202 after the export row and its contentless queue row commit together. `worker-report` is an eighth process role with its own bounded concurrency; it discovers only a tenant and export id, then enters that tenant's RLS transaction before reading report data.

**The file is stable evidence.** The worker reads the narrow `campaign_report_rows` projection, optionally scopes it to one campaign, emits CRLF CSV with formula-leading cells neutralized, stores the row count and SHA-256 digest, and exposes a membership-owned download for 24 hours. Queued/running/failed/completed are different states in the API and Analytics UI.

**A dead worker cannot own the job forever.** Claims are five-minute leases. An abandoned lease can be recovered up to three attempts; the next sweep closes it as `export_attempts_exhausted`. A generation failure records `export_generation_failed` and removes the queue row. Tests force both failures against PostgreSQL rather than asserting a mock.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0025_campaign_report_exports.sql` | FORCE-RLS export record, contentless queue, leases and expiry |
| `apps/api/src/campaigns/report-export.service.ts` | idempotent creation, ownership, CSV generation, recovery and download |
| `apps/api/src/workers/worker-roles.ts` | separately scalable `worker-report` role |
| `apps/web/src/ui/workspace.ts` | real export action, progress state and expiring download |
| `tests/integration/api-campaigns.test.ts` | completion, digest, formula safety, expiry and forced failure evidence |
| `docs/api/openapi.v1.json` | pinned 101-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm typecheck` | **0** | clean |
| `pnpm test:unit` | **0** | **1460 tests** |
| `pnpm test:integration` | **0** | **509 tests** against PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 101 files, **1974 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | 101-operation OpenAPI drift clean |

### Honest remaining production scope

- The checked Railway project currently runs only the static web service; the API, PostgreSQL and workers still need production services and secrets.
- Provider-live activation remains `blocked_no_asset`; the UI accepts the future Meta identifiers, but live Graph transport cannot be asserted without the owner's app assets.
- CRM remains intentionally deferred by the owner. Contact import/export and template catalogue/synchronization are separate later scope.

**Next execution slice:** package the shared production artifact, proxy `/api` from the public web service, provision Railway PostgreSQL/API/workers, migrate, bootstrap and smoke-test the public path.

---

## Last completed task — P1-T17 (failed-only campaign retry)

**Task / requirement IDs:** CMP-24 implemented; UX-09 advanced.

### Behavior delivered

**Retry means failed only.** `POST T/campaigns/{id}/retry` requires `campaign.control`, CSRF and an idempotency key. The campaign lifecycle table accepts it only from `dispatch_completed` or `failed`; it reopens the original execution and advances the existing stop fence. It creates no second execution and never includes accepted, delivered, read, skipped, cancelled or `outcome_unknown` recipients.

**Both commands remain evidence.** Each failed recipient receives a new exact copy of its previous immutable outbound command. `campaign_retry_runs` records the operator and count, while `campaign_retry_recipients` links the recipient, previous command, replacement command and previous typed error. The current recipient pointer advances without deleting the old provider attempt.

**Budget drift fails closed.** A retry can reserve only the original estimate of a reservation currently in `released`. If even one failed recipient has a different budget state, the retry run, replacement commands, state changes and outbox writes all roll back in one transaction.

**Broadcasts exposes the committed command.** Terminal campaign cards show “Retry failed only” only to a role holding `campaign.control`. The success message uses the server's committed recipient count; a refusal produces no success toast.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0024_campaign_failed_retry.sql` | immutable retry-run and old/new command evidence |
| `packages/domain/src/campaigns/lifecycle.ts` | closed terminal-to-running retry transition |
| `apps/api/src/campaigns/campaign.service.ts` | failed-only selection, fencing, budget reservation and atomic queueing |
| `apps/web/src/ui/workspace.ts` | role- and state-gated Broadcasts action |
| `tests/integration/api-campaigns.test.ts` | accepted/failed/unknown isolation, idempotency and rollback evidence |
| `docs/api/openapi.v1.json` | pinned 98-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 208.96 kB / 61.97 kB gzip |
| `pnpm test:unit` | **0** | 77 files, **1456 tests** |
| `pnpm test:integration` | **0** | 23 files, **506 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 101 files, **1967 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | 98-operation OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | **373 tests** including failed-only retry + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |

### Honest remaining scope

- CMP-23 still needs a scoped asynchronous export job.
- Template catalogue/synchronization remains before provider activation.
- Provider-live activation remains `blocked_no_asset`; CRM remains intentionally deferred by the owner.

**Next execution slice:** scoped asynchronous report export, then production deployment checks and Railway release.

---

## Previously completed — P1-T16 (campaign reporting + live Analytics)

**Task / requirement IDs:** CMP-22 implemented; CMP-23 partial; REP-01..03 partial; REP-04 and REP-05 implemented; UX-09 advanced.

### Behavior delivered

**Analytics now reads the server.** `GET T/reports/campaigns` is authorized by `report.read` and returns campaign execution evidence from the tenant-isolated `campaign_report_rows` projection. The UI has distinct session, loading, denial, network-failure and ready states and refreshes through the real endpoint.

**Counts cannot be added twice.** Current recipient states are ten disjoint counters whose sum is mechanically checked against one denominator. Accepted, delivered and read are separate cumulative milestones over the same denominator, so a delivered recipient is not added again to accepted when reporting a total.

**Unknown and unsupported remain explicit.** `outcome_unknown` has its own current-state card and is labelled never automatically retried. Receipt support comes from the connection capability matrix; unsupported reads render `not_available`, never zero or 0%. Error categories come from typed ledger codes.

**Costs retain their meaning.** Exact decimal estimated, committed and reconciled amounts are returned and rendered as separate columns per currency. The report publishes UTC, generation time and the newest evidence instant.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0023_campaign_reporting.sql` | tenant-isolated reporting projection |
| `apps/api/src/campaigns/reporting.service.ts` | one defined aggregate and `report.read` boundary |
| `apps/web/src/ui/workspace.ts` | live bilingual Analytics states and metrics |
| `tests/integration/api-campaigns.test.ts` | PostgreSQL denominator, milestone, errors and cost reconciliation |
| `docs/api/openapi.v1.json` | pinned 97-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 208.14 kB / 61.80 kB gzip |
| `pnpm test:unit` | **0** | 77 files, **1453 tests** |
| `pnpm test:integration` | **0** | 23 files, **505 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 101 files, **1963 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | **372 tests** including campaign security + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests**, including the live Analytics baseline |

### Honest remaining scope

- CMP-23 still needs a scoped asynchronous export job.
- CMP-24 failed-only retry remains.
- Provider-live activation remains `blocked_no_asset`; CRM remains intentionally deferred by the owner.

**Next execution slice:** failed-only safe campaign retry, then scoped export and production deployment checks.

---

## Previously completed — P1-T15 (Milestone F: safe campaign test-send)

**Task / requirement IDs:** CMP-05 implemented; UX-09 advanced for Channels and Broadcasts.

### Behavior delivered

**A campaign test can reach only an explicitly authorized identity.** A manager authorizes a live contact identity on one exact channel connection and may revoke it without erasing history. The campaign request carries only that authorization ID and the version the operator reviewed; there is no arbitrary phone, username or provider ID field to edit into a different recipient.

**A test uses the production send path without becoming a campaign execution.** The server renders the exact immutable revision, commits an ordinary interactive outbound command, outbox row and immutable test-send evidence together, then returns 202. It creates no audience snapshot, execution or campaign recipient and therefore cannot distort campaign totals.

**The final permit is rechecked at dispatch.** A queued test is skipped before provider I/O if its authorization is revoked, its identity/contact is no longer live, the campaign revision changes, the channel loses readiness, the reply window closes, suppression appears or the credential is revoked. Custom variable aliases such as `{{first_name}} -> display_name` use the same rendering rule as a frozen campaign audience.

**Channels and Broadcasts are wired to the server.** Channels lists, authorizes and revokes test recipients. Broadcasts offers Test Send only for an editable campaign and only shows authorizations for that campaign's connection. Loading and refusals remain distinct, and success is shown only after the 202 transaction commits.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0022_campaign_test_send.sql` | scoped authorization history, immutable send evidence, RLS and audit vocabulary |
| `apps/api/src/campaigns/campaign.service.ts` | authorization management and transactional test-send command |
| `apps/api/src/channels/dispatcher.service.ts` | dispatch-time authorization and revision fences |
| `apps/web/src/ui/channels-screen.ts` | allowlist controls on each connection |
| `apps/web/src/ui/dialogs.ts` | campaign Test Send recipient chooser |
| `tests/integration/api-campaigns.test.ts` | rejection, idempotency, rendering and zero-provider-call fence evidence |
| `docs/api/openapi.v1.json` | pinned 96-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 205.27 kB / 61.04 kB gzip |
| `pnpm test:unit` | **0** | 76 files, **1450 tests** |
| `pnpm test:integration` | **0** | 23 files, **505 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 100 files, **1960 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | **372 tests** including campaign security + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests**, with server-ready Channels, People and Broadcasts structures |

### Honest remaining scope

- Template catalogue/synchronization and failed-only campaign retry remain.
- Campaign aggregation/export and the live Analytics screen remain.
- Provider-live activation remains `blocked_no_asset`; CRM remains intentionally deferred by the owner.

**Next execution slice:** campaign reporting and the live Analytics screen, followed by failed-only retry and production deployment checks.

---

## Previously completed — P1-T14 (Milestone F: immutable campaign revision editing)

**Task / requirement IDs:** CMP-06 and CMP-09 completed with a production update path; UX-09 advanced for Broadcasts.

### Behavior delivered

**Broadcasts now edits real campaigns.** Draft and ready cards expose Edit; the dialog is populated from the server revision and preserves its channel, variables, expiry, budget and any filter/content fields outside the visible form. A committed save closes the dialog and reloads server state. A refusal stays visible without an optimistic success.

**Delivery changes create immutable history.** `PATCH T/campaigns/{id}` compares the submitted delivery hash with the current revision under a row lock. Name/objective-only changes keep the same revision, frozen audience and approval. A change to channel, content, variables, audience, timezone, expiry or budget inserts the next revision, moves the campaign to Draft and leaves the new revision with no snapshot or approval. Earlier revisions, snapshots and approvals remain immutable audit evidence.

**Lost updates and unsafe retries are closed.** The browser sends the version it rendered. The server compares it after taking the campaign lock; two concurrent edits from one version yield exactly one 200 and one typed `version_conflict`. The mutation also requires an idempotency key, so an identical retry returns the committed revision while a changed retry is rejected. Scheduled, running and terminal campaigns return `campaign_edit_locked` and direct the operator to Clone.

### Main files

| Path | Purpose |
|---|---|
| `apps/api/src/campaigns/campaign.service.ts` | locked revision comparison, immutable insert and replay-safe update |
| `apps/api/src/campaigns/campaign.controller.ts` | authenticated `PATCH` boundary |
| `apps/web/src/ui/dialogs.ts` | server-populated campaign editor |
| `apps/web/src/live/dispatch.ts` | versioned committed save |
| `tests/integration/api-campaigns.test.ts` | metadata-only, meaningful, stale, concurrent, replay and post-launch evidence |
| `docs/api/openapi.v1.json` | pinned 92-operation contract and full editable campaign representation |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 198.95 kB / 59.44 kB gzip |
| `pnpm test:unit` | **0** | 74 files, **1442 tests** |
| `pnpm test:integration` | **0** | 23 files, **504 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 98 files, **1951 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | 354 tests + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests**, including the revised Broadcasts structure |

### Honest remaining scope

- Explicit authorized test-send and template catalogue/synchronization remain.
- Failed-only retry, provider price reconciliation and staging load/recovery measurements remain.
- Campaign aggregation/export and the live Analytics screen remain.
- Provider-live activation remains `blocked_no_asset`; CRM remains intentionally deferred by the owner.

**Next execution slice:** explicit safe campaign test-send, then campaign reporting and the live Analytics screen.

---

## Previously completed — P1-T13 (Milestone F: safe campaign cloning)

**Task / requirement IDs:** CMP-10 implemented.

### Behavior delivered

**Every campaign can now be cloned from Broadcasts into a distinct draft.** The browser derives a bounded Arabic or English copy name, marks the action busy, waits for the committed response and then reloads the server list. Refusals stay beside the screen and never produce a success toast.

**The server copies the definition and nothing operational.** The new campaign receives a new ID and revision 1 with the source objective, connection, variables, audience filter, content, timezone, expiry and budget. Its immutable revision hash remains the same because the delivery definition is the same. Audience snapshots, approvals, executions, recipients and their provider evidence are not copied. The referenced connection must still exist.

**Clone is replay-safe.** `POST T/campaigns/{id}/clone` requires CSRF and an idempotency key. Replaying the same body returns the original clone; changing the body behind the same key returns `idempotency_key_reused`. Unknown sources return 404 without creating a partial campaign.

### Main files

| Path | Purpose |
|---|---|
| `apps/api/src/campaigns/campaign.service.ts` | definition-only transactional clone and audit evidence |
| `apps/api/src/campaigns/campaign.controller.ts` | authenticated clone endpoint |
| `apps/web/src/live/campaign-actions.ts` | committed UI mutation and bounded localized name |
| `apps/web/src/ui/workspace.ts` | Clone control on live Broadcasts cards |
| `tests/integration/api-campaigns.test.ts` | new-ID, no-operational-state and idempotency evidence |
| `docs/api/openapi.v1.json` | pinned 91-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 196.79 kB / 58.90 kB gzip |
| `pnpm test:unit` | **0** | 74 files, **1440 tests** |
| `pnpm test:integration` | **0** | 23 files, **502 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 98 files, **1947 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | 354 tests + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests**, including the updated Broadcasts structure |

### Honest remaining scope

- Clone deliberately does not mutate its source or bypass the approval lifecycle. Editing a clone into a new immutable revision is still to be built.
- Template catalogue/synchronization, explicit test-send and failed-only retry remain.
- Campaign aggregation/export and the live Analytics screen remain.
- Provider-live activation remains `blocked_no_asset`; CRM remains intentionally deferred by the owner.

**Next execution slice:** edit-as-new-revision and explicit safe test-send, then campaign reporting and the live Analytics screen.

---

## Previously completed — P1-T12 (Milestone F: durable campaign planning and dispatch)

**Task / requirement IDs:** CMP-03, CMP-14, CMP-20 and CMP-21 implemented; CMP-11, CMP-13, CMP-17 and CMP-18 partial with their remaining measured/operational work named below.

### Behavior delivered

**A scheduled campaign now becomes real outbound work.** Launch commits a contentless due-time queue row beside the execution. `worker-campaign` discovers the company from that queue, enters tenant RLS, locks campaign → execution → queue in the same order as pause/cancel, and turns frozen recipients into the ordinary outbound commands the existing fair bulk dispatcher already understands. Personalization is rendered only from values frozen in the approved audience snapshot; an integration assertion reads the final command and proves `{{display_name}}` became the frozen name rather than live data or a literal placeholder. A tested planner/pause race completes without deadlock and never dispatches after pause.

**Every command carries the campaign stop fence.** Pause removes due work and blocks already-queued commands. Resume increments the execution version, refreshes only safe queued/retry commands and re-adds durable planner work. Cancel removes unsent outbox rows, marks only planned/queued recipients cancelled and releases their reservations; it does not claim to recall anything already in flight.

**Eligibility is checked twice and kept twice.** Snapshot evidence stays immutable. Immediately before provider I/O, dispatch independently verifies the execution and campaign are running, the recipient is in flight, the stop version still matches, the exact revision approval is live, expiry has not passed, current marketing consent is granted and the channel is healthy. A refusal writes typed dispatch evidence, skips without a provider call and releases the reservation.

**Provider outcomes update the campaign ledger without conflating meanings.** Accepted commits the reservation; a definite permanent rejection releases it; a retry-safe rejection returns the recipient to `queued`; `outcome_unknown` is terminal for automatic dispatch and holds the reservation for reconciliation. `dispatch_completed` means no recipient remains planned/queued/in flight and remains separate from provider delivery. Tests exercise all four projections and prove an accepted campaign completes while its recipients are not falsely labelled delivered.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0021_campaign_dispatch_queue.sql` | durable due queue, command linkage uniqueness and stop fence |
| `apps/api/src/campaigns/campaign-planner.service.ts` | due execution start and bounded recipient planning |
| `apps/api/src/campaigns/campaign-dispatch.ts` | pure dispatch-time campaign policy and outcome projection |
| `apps/api/src/channels/dispatcher.service.ts` | final eligibility recheck, fenced sending and ledger/budget projection |
| `apps/api/src/workers/worker-roles.ts` | campaign planning before the fair bulk dispatch round |
| `tests/integration/api-campaigns.test.ts` | consent/readiness/pause/cancel/race/outcome evidence on PostgreSQL |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 196.22 kB / 58.77 kB gzip |
| `pnpm test:unit` | **0** | 74 files, **1439 tests** |
| `pnpm test:integration` | **0** | 23 files, **501 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 98 files, **1945 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | 354 tests + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests** |

### Honest remaining scope

- Template catalogue/synchronization, explicit test-send, edit-as-new-revision, clone and failed-only retry are not built.
- Campaign delivery aggregation/export and the broader Analytics/SLA/business-hours read models remain; Analytics and Settings are still demo-backed.
- The planner and dispatcher are bounded, durable and restart-safe by construction, but the one-million-recipient target, interactive p95 under bulk load and restore drill still require a staging target.
- Exact budget reserve/commit/release/unknown handling is wired. Provider price reconciliation remains blocked until a real provider account supplies billable evidence and current price-card sources.
- **No live provider HTTP client yet.** Activation remains `blocked_no_asset` until the owner supplies Meta App credentials and Phone/Page/Instagram asset IDs.
- **CRM remains intentionally deferred by the owner** and is outside the MVP release critical path.

**Next execution slice:** template management and safe campaign test-send/revision/clone paths, followed by campaign reporting and the live Analytics screen.

---

## Previously completed — P1-T11 (Milestone F: campaign core and live Broadcasts UI)

**Task / requirement IDs:** CMP-01, CMP-02, CMP-04, CMP-06, CMP-08 and CMP-09 implemented; CMP-03, CMP-14, CMP-17 and CMP-20 partial. UX-09 remains `partial` because Analytics and Settings are still demo-backed and campaign dispatch workers are the next slice.

### Behavior delivered

**Broadcasts now uses the API and PostgreSQL.** The old campaign cards and local launch success path are gone. An authorized operator can create a draft against a healthy channel, freeze its audience, approve the exact immutable revision, launch it now or through the scheduling API, pause/resume/cancel future work, and open the per-recipient ledger. Loading, empty, refusal and committed-success states are distinct.

**The campaign lifecycle is one total transition table.** Invalid transitions are typed `409` responses. A second validation of the same immutable revision is rejected before touching its one audience snapshot; this replaced a database-constraint `500` found by the integration tests.

**Review evidence cannot drift after approval.** `campaign_revisions`, audience snapshots and their member rows are immutable at the runtime role. Audience selection and member insertion come from the same materialized SQL candidate set, so the totals shown for approval are the rows launch uses. Approval carries the revision hash, and the database foreign key verifies it belongs to that revision.

**Launch is atomic and replay-safe.** The execution, frozen recipients and exact-decimal budget reservations commit together. One campaign ID has one execution under concurrent calls. The same idempotency key and body returns the original result; the same key with a changed request is a conflict. Cancellation changes only planned/queued recipients and never claims to recall a provider request already on the wire.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0020_campaign_core.sql` | campaign definitions, approvals, snapshots, execution, ledger, budgets, RLS and immutable evidence |
| `packages/domain/src/campaigns/lifecycle.ts` | closed campaign state machine |
| `apps/api/src/campaigns/` | seven server operations and request validation |
| `apps/web/src/api/campaigns.ts` | typed browser client |
| `apps/web/src/live/campaign-actions.ts` | committed workflow mutations |
| `apps/web/src/ui/workspace.ts` | server-backed Broadcasts screen and recipient ledger |
| `docs/api/openapi.v1.json` | pinned 90-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 196.24 kB / 58.78 kB gzip |
| `pnpm test:unit` | **0** | 73 files, **1421 tests** |
| `pnpm test:integration` | **0** | 23 files, **493 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 97 files, **1919 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | OpenAPI drift clean; channel contracts pass |
| `pnpm test:security` | **0** | 354 tests + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests**, including reviewed Broadcasts pixels and structure |

### Honest remaining scope

- The recipient ledger is durable, but a `worker-campaign` planner has not yet turned planned recipients into outbound commands. Scheduled executions likewise need a durable due-time sweeper. This is the next execution slice.
- Dispatch-time eligibility, reservation release/commit/reconciliation and campaign attempt aggregation remain to be wired to the existing outbound dispatcher.
- Templates, test-send, edit/revise, clone and retry-failures are not built yet.
- **Analytics and Settings are still demo-backed.** Campaign reporting/export and SLA/business-hours read models remain.
- **No live provider HTTP client yet.** Provider activation remains `blocked_no_asset` until the owner supplies Meta App credentials and Phone/Page/Instagram asset IDs.
- **CRM remains intentionally deferred by the owner** and is not on the MVP release critical path.

**Next execution slice:** implement the durable campaign scheduler/planner and dispatch-time recheck, using the existing campaign worker role, outbound command dispatcher and fairness machinery.

---

## Previously completed — P1-T10 (Milestone E: labels, typed custom fields and deployment-ready channel slots)

**Task / requirement IDs:** CON-08 and CT-05 closed. UX-09 remains `partial` only because Broadcasts, Analytics and Settings are still demo-backed.

### Behavior delivered

**Labels and business fields are server-owned data.** Labels can be created, edited and retired. Contact and conversation assignments are intervals with the assigning/removing actor, so removal never erases who applied a label earlier. Custom fields target either a contact or a conversation and carry a real type: text, number, boolean, date, single select or multi select. Target, key and type are immutable after creation because changing any of them would reinterpret history.

**One form change is one versioned command.** Label additions/removals and field sets/clears commit together against the entity version the operator saw. A stale drawer receives a typed version conflict rather than overwriting somebody else's work. The runtime role can append metadata audit evidence but cannot rewrite or delete it; PostgreSQL repeats the API's target/state/type/option checks.

**Search does not damage Arabic source data.** Contact names and JSON field values remain exactly as entered. Separate bounded search columns hold normalized representations, and the integration suite retrieves Arabic data through normalization then asserts the original is unchanged. Contact and Inbox filters are evaluated in SQL under tenant RLS, including label and typed-field equality filters.

**The live UI uses the catalogue.** Contacts and Inbox load labels/fields from the API, distinguish loading/empty/refused states, render values by type and wait for the committed response before success. Retired definitions stay readable on existing records but cannot receive new assignments.

**The channel form now accepts the values the owner will provide later.** Meta connections take a configured Meta App ID plus the channel asset (Phone Number ID, Page ID or Instagram Account ID). Website Chat and Custom Channel intentionally omit the Meta field. The API resolves the public App ID to an active server configuration and refuses missing or unknown apps; secrets remain server-side and are never returned.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0019_metadata_catalogue.sql` | tenant-scoped catalogue, assignment intervals, typed values, audit and search columns |
| `packages/domain/src/metadata/custom-fields.ts` | Unicode search normalization and typed-value validation |
| `apps/api/src/metadata/` | ten catalogue/entity metadata operations |
| `apps/web/src/ui/metadata-section.ts` | shared Contact/Conversation metadata editor |
| `apps/web/src/live/metadata-actions.ts` | committed mutations and catalogue loading |
| `apps/api/src/channels/channel.service.ts` | Meta App ID resolution and first-party channel handling |
| `apps/web/src/ui/channels-screen.ts` | kind-specific connection fields and readiness evidence |
| `docs/api/openapi.v1.json` | pinned 83-operation contract |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web 191.29 kB / 57.74 kB gzip |
| `pnpm test:unit` | **0** | 69 files, **1379 tests** |
| `pnpm test:integration` | **0** | 21 files, **480 tests** against PostgreSQL 17.4 |
| `pnpm test:property` | **0** | 5 exhaustive/metamorphic properties |
| `pnpm test:coverage` | **0** | 91 files, **1864 tests**, **100/100/100/100** |
| `pnpm test:contracts` | **0** | 170 unit + 121 integration; OpenAPI drift clean |
| `pnpm test:security` | **0** | 354 tests + production audit; no known vulnerabilities |
| `pnpm test:e2e` | **0** | **150 tests** at 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **25 tests**, no WCAG 2.1 AA axe violations |
| `pnpm test:visual` | **0** | **20 tests**, reviewed images plus structural snapshots |

The coverage run exposed a calendar-dependent test fixture: a hard-coded inbound timestamp had crossed the real 24-hour WhatsApp reply window, so valid text replies became `template_required`. The fixture now uses the current provider timestamp only where it is meant to open a window; the normalization assertion still passes an explicit historical time. The complete channel integration file passes again.

### Honest remaining scope

- **Broadcasts/Campaigns are the largest product gap.** The screen is still demo data and the campaign state machine, audience snapshot, approval, scheduling, recipient ledger and operational controls are not built.
- **Analytics and Settings are still demo-backed.** SLA/business-hours/report read models are unbuilt.
- **No live provider HTTP client yet.** The form and server configuration seam are ready for the owner's Meta App ID, Phone/Page/Instagram IDs and access tokens; provider-live evidence remains `blocked_no_asset` until those assets are supplied.
- **CRM is intentionally deferred by the owner.** It is not a release prerequisite for this MVP.
- Merge/import/export/segments, MFA/SSO and advanced media remain later scope.
- Mutation, target-load and recovery drills still need their P4/staging environments.

**Next execution slice at that point:** replace the Broadcasts demo with the real campaign core and UI. Completed in P1-T11 above.

---

## Previously completed — P1-T8 third slice (Milestone D: the conversation lifecycle, notes and read state)

**Task / requirement IDs:** CON-02, CON-03, CON-04, CON-05, MSG-04 closed. CON-01 completed (its archive dimension). CON-07 moved to `partial` with the unbuilt half named.

### Behavior delivered

**§18.1 is a table, not a set of `if`s.** The eleven rows live in `packages/domain/src/conversations/lifecycle.ts` as data, decided by one function. Three properties follow that do not survive scattering the rules across handlers. A trigger that changes nothing is an *explicit row* — a receipt, a typing indicator and a private note reopen nothing, and that is stated rather than falling through. A refusal is a **value**, so the API turns it into a 409 named after the refusal and the browser renders it in the operator's words. And the side effects are named by the row, so *start a new reporting episode* cannot be forgotten by the one caller that reopens a conversation from an unusual place.

**Triggers are causes, not commands.** `customer_inbound` is a fact that arrived; the table decides what it means from where the conversation already was. An endpoint named `reopen` would let a caller assert an outcome instead of reporting a cause — so there is one `POST .../transitions` taking a command, fenced on the version the agent saw.

**A snooze stores the instant *and* the zone.** They answer different questions: the instant is when the job fires, the zone is what the operator meant. A system keeping only the instant cannot re-derive "tomorrow morning" after a DST change. The zone is validated against the runtime's own IANA database at the door, so an unknown one fails in front of the person who chose it rather than in a worker six hours later. The wake is a row in `conversation_wakes` fenced by `wake_version`: re-snoozing bumps it so the job already scheduled matches nothing, and the sweeper's guarded `UPDATE` makes a stale job a no-op that is deleted rather than one that fires early. The browser sends an **instant**, never a duration — a duration would be resolved against the server's clock while the operator picked it against theirs.

**A reopen starts a new episode.** Reusing the first would start the second issue's clock at the first issue's first message and make every resolution-time report a lie. The first episode keeps its own numbers. `first_response_at` is written inside the **same transaction as the reply command** and coalesces, so the first response is the first — that also fixed a real gap: `noteResponse` existed with **no callers**, so `first_response_at` would have been null forever and the metric silently useless.

**The identity is held until archival, not until resolution.** The uniqueness constraint became a partial index over non-archived rows, which is what lets an archived thread keep its history while the customer's next message opens a thread of its own.

**A note is never a message.** Its own composer, its own draft field, its own table, and an explicit no-op row in the lifecycle table so it cannot reopen anything. A deletion keeps the row and its attribution and drops only the text — a thread that silently lost an internal remark could not be reconstructed. Only the author may edit or delete, which is a **403 rather than a 404**, because the caller may read it.

**Unread is derived, not counted.** One `conversation_reads` row per person compared against `last_activity_at`, so there is no count for anybody to keep correct and two agents never see each other's state. The cursor never moves backwards and refuses a read of the future. The browser marks read only once the timeline is actually on screen: a cursor moved before the messages arrived would mark as seen what a failed load never showed anybody.

**An offered control is one the server can accept.** The browser holds a copy of §18.1's availability, and a unit test **regenerates it from `applyTrigger`** and fails on any divergence — so a button that would always be refused cannot ship. `@convo/domain` is a **devDependency** of `@convo/web` for exactly this: a test-time oracle, never a runtime import, and the bundle stays dependency-free.

**Four defects this work surfaced.** `noteResponse` had no callers, as above. `relativeTime` is past-only, so a future wake time fell into its first branch and read as *now* — the one answer that is certainly wrong for a snooze; `futureTime` was written beside it and a test asserts the two disagree. `mount({ now })` was overwritten by the first render, so the injected clock made nothing deterministic and a snooze offset could not be asserted at all. And the visual suite's own doc claimed every screen baseline was paired with a structural snapshot, but the Inbox had images only — so an entire panel section could be added below the fold of a scrolling zone without moving a pixel; it now has one.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0017_conversation_lifecycle.sql` | the five states, the wake job, episodes, notes and read cursors |
| `packages/domain/src/conversations/lifecycle.ts` | §18.1 as data, and the snooze check |
| `apps/api/src/conversations/lifecycle.service.ts` | authorize → ask the table → fence the version → write → announce |
| `apps/api/src/conversations/note.service.ts` | notes, the authorship rule, and the read cursor |
| `apps/api/src/conversations/record.ts` | the shared conversation read, and the schema/domain drift guard |
| `apps/web/src/ui/lifecycle-panel.ts` | the controls, the notes and the episodes |
| `apps/web/src/live/lifecycle-actions.ts` | transitions, notes and the read cursor, with the refusals in the operator's words |
| `apps/web/src/live/lifecycle.test.ts` | 57 tests, opening with the one that regenerates the browser's table from the domain's |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 161.57 kB / 49.26 kB gzip |
| `pnpm test:coverage` | **0** | **1616 tests**, 100% on all four metrics |
| `pnpm test:contracts` | **0** | 166 unit + 119 integration |
| `pnpm test:security` | **0** | 283 tests + production audit, **no known vulnerabilities** |
| `pnpm test:e2e` | **0** | 148 |
| `pnpm test:a11y` | **0** | 25, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 20, images plus structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **64 operations**; the bidirectional drift test passes.

A production dependency audit finding was fixed rather than waived: `@nestjs/platform-fastify` pins `fastify@5.11.3` exactly, so the **running** server loaded a copy with two moderate advisories even though our own direct dependency was already patched. A `pnpm.overrides` entry collapses both copies onto `5.12.3`, and `pnpm audit --prod` is now clean.

### Honest remaining scope

- **No assignment to others, no handoff, no labels, no SLA.** `conversation.assign` exists as a permission and has no endpoint; claiming yourself is the only way work moves.
- **No bot/human ownership dimension**, which is why CON-07 is `partial`: there is no bot.
- **Snooze offers offsets and a specific time, not calendar phrases.** "Tomorrow morning" is a question about a zone, a working day and a DST rule; offsets are one instant everywhere, so that is what the presets are.
- **Notes have no mentions, no attachments and no search.**
- **Drafts still live in memory.** A failed send keeps what was typed; a reload does not.
- **Still no provider HTTP client and no broker product.** Every provider-live check stays `blocked_no_asset`; DEL-08/DEL-09 stay `blocked_env`.

---

## Previously completed — P1-T8 second slice (Milestone D: Contacts, identity and consent)

**Task / requirement IDs:** CT-01, CT-02, CT-03, CT-06, CT-08 closed. CT-07 partial, with the unbuilt half named.

### Behavior delivered

**A contact exists because somebody wrote to us.** There is no `createContact`, no import, and no form that turns a typed-in phone number into a person. Contacts are created by `ContactService.resolve` when a customer's first message is normalized, from the scoped triple the provider actually delivered. The absence is asserted by the browser suite, not merely documented: it looks for a create control and a merge control and requires both to be missing.

**An identity is scoped, and never inferred.** `contact_identities` keys on `(kind, scope_id, external_id)` where the scope is a channel connection, so the same number reaching two connections is two identities and the same person messaging two Pages is two identities. `resolve` matches that triple exactly and has **no fuzzy path to fall back to** — no similar name, no matching username, no phone number that looks the same with a different country prefix.

**Rotation closes an interval; it does not overwrite a column.** The unique index is partial — one *live* row per scoped external id, unbounded history behind it. A number reassigned to somebody else is the case that decides the design: the messages sent to it before the reassignment belong to whoever held it then, and an overwrite would silently re-attribute them. A closed identity is returned by the API and rendered as **ended** rather than hidden.

**Consent is evidence, not a switch.** The runtime role holds `SELECT, INSERT` on `consents` and nothing else, under FORCE RLS — a withdrawal is a new row and the current state is the newest row per (contact, channel, purpose). The integration suite proves the role is refused both an `UPDATE` and a `DELETE`, because rewriting a withdrawal into a grant and deleting it outright are the same lie told two ways.

**Two refusals are part of the contract.** `source=import` with `state=granted` is **422 `import_is_not_consent`**: a row in a spreadsheet is not somebody agreeing to be messaged. A grant on a channel the contact is suppressed on is **409 `suppression_outranks_consent`**: an opt-out outranks any consent, and lifting one needs an explicit opt-in workflow this build does not offer. Both reach the operator in their own words rather than as a generic failure. The panel renders a suppression **above** the consent history for the same reason — a green *opted in* sitting over an opt-out would be the exact lie the model exists to prevent.

**Suppression is not a column on the contact.** It stays in `channel_suppressions`, keyed by `(kind, peer_identity)`, and a contact's suppressed channels are derived by joining its **live** identities against it. That is what makes "a suppression survives a merge, a deletion and a CRM import" true rather than hopeful, and it means an ended identity cannot carry a suppression forward to whoever holds the number now.

**A contact outlives the channel it arrived on.** `contact_identities.scope_id` cascades from `channel_connections`, so a hard-deleted connection can leave a contact with no identity rows at all. The directory keeps such a contact rather than dropping it: the consent history is attached to the contact, and losing the row would lose the answer to whether we may write to them.

**The search is over the name a human wrote.** There is no search by number, because matching a similar one is the inference the model refuses. The screen says so on screen rather than only in a comment.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0016_contacts.sql` | `contacts`, `contact_identities`, `consents`, `conversations.contact_id` |
| `apps/api/src/contacts/contact.service.ts` | resolve, list, read, update, record consent; the single `detailOf` assembler |
| `apps/api/src/contacts/contact.controller.ts` | the four routes and their validation |
| `apps/web/src/api/contacts.ts` | the typed client — `ContactSummary` and `Contact` kept apart, as on the server |
| `apps/web/src/live/contact-actions.ts` | the panel and the directory, holding separate state on purpose |
| `apps/web/src/ui/contact-panel.ts` | who they are, how we reach them, what they agreed to — in that order |
| `apps/web/src/ui/contacts-screen.ts` | the directory, and the four things it deliberately does not offer |
| `apps/web/src/live/contacts.test.ts` | 31 tests through the real client, actions and renderer |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 145.65 kB / 44.75 kB gzip |
| `pnpm test:coverage` | **0** | 82 files, **1483 tests**, 100% on all four metrics |
| `pnpm test:contracts` | **0** | 166 + 119 across the adapter and OpenAPI contract suites |
| `pnpm test:security` | **0** | 7 files, 248 tests + `pnpm audit --prod` → **no known vulnerabilities** |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 25, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 19, images plus structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **57 operations**; the bidirectional drift test passes.

**A real vulnerability was closed on the way past.** `pnpm audit --prod` reported two moderate fastify advisories — a schema-validation bypass and `X-Forwarded-*` spoofing under `trustProxy`. Our own dependency was already patched at 5.12.3; `@nestjs/platform-fastify@11.2.3` pins `fastify: 5.11.3` exactly, so pnpm installed a **nested** vulnerable copy, and that nested copy is the one `FastifyAdapter` loads at runtime. The `high` audit level meant the gate was passing over it. A `pnpm.overrides` entry collapses both copies onto 5.12.3; the full suite re-run confirms nothing depended on the older minor.

### Honest remaining scope

- **No merge, and no merge preview.** Whether two identities are one person is a reviewed decision with an audit trail (CT-04), and neither the review nor the trail exists. An unreviewable merge button would be worse than none, so there is not one.
- **No CSV import and no export.** CT-07's rule is enforced today at the endpoint that could violate it, but it guards a door nobody can walk through yet; CT-09 and CT-10 are untouched.
- **No tags, custom-field catalogue, segments or normalized search representation** (CT-05, CT-11). The directory search is a plain `ILIKE` over the display name, capped at 200 rows and uncursored.
- **No contact deletion request** (CT-13's re-opt-in workflow and the P8 privacy path are both absent). A suppression cannot be lifted through the API at all, which is the safe direction to be incomplete in.
- **Consent is recorded, not yet enforced at send time by this slice.** The dispatcher's own consent gate predates this work and reads `channel_suppressions`; wiring the `consents` history into the permit is DEL-work, not done here.
- **Still no provider HTTP client and no broker product.** Every provider-live check stays `blocked_no_asset`; DEL-08/DEL-09 stay `blocked_env`.

---

## Previously completed — P1-T8 first slice (Milestone D: the real Inbox)

**Task / requirement IDs:** CON-01, MSG-01, MSG-05, IAM-11 closed. MSG-02 and UX-09 moved to `partial` with the unbuilt half named.

### Behavior delivered

**The Inbox reads from the server and nowhere else.** The demo inbox screen, its filters, its saved views, its drafts and its 27 demo actions are deleted rather than disabled. What replaced them calls endpoints: the Unassigned queue, this agent's own conversations, one conversation's timeline, a version-checked claim, a reply, and a live subscription.

**The preview-state switcher is gone.** Loading, empty, offline and permission-denied are still on screen — as the server's answers. The accessibility and visual suites reach them by scripting the API, which is the only way they can occur in the shipped product.

**A card is a card all the way down.** The browser renders a projected queue card because a card is all the server sent: there is no snippet in the payload for a screen to be trusted to hide. Asserted by serialising the rendered queue and looking for the customer's identity in it.

**Claiming carries the version the agent saw.** That meant adding `version` to `QUEUE_CARD_FIELDS` — a deliberate change to a closed list, recorded as such: IAM-13 requires the version the agent saw, and the agent who sees a card is exactly the one who may not read the conversation to find it. Losing the race is reported as a colleague getting there first, not as an error.

**Replying is addressed to a conversation.** The recipient comes from the record; a `peerIdentity` in the body is ignored, which the integration test proves. Everything after that is the existing outbound path.

**Realtime says what changed; the server says what it is.** Every event triggers a re-read of the endpoint that owns it, so a caller gets exactly what they are allowed rather than whatever a payload carried. `EventSource` owns reconnection — two retry loops racing is how one restart becomes a request storm — and the client closes the stream only when coming back is pointless. A dropped stream is on screen, because a stalled inbox and a quiet one look identical.

**Three defects this work surfaced.** A `<textarea>` ignores a `value` attribute, so the composer emptied itself on every re-render — a realtime event arriving mid-sentence would have deleted what an agent was typing. Every URL sync re-entered the router and rendered twice, so a language toggle re-fetched the whole inbox. And `OutboundService.queue` authorized `conversation.reply` with no resource, making the send path unusable by the one role it exists for.

### Main files

| Path | Purpose |
|---|---|
| `apps/api/src/conversations/conversation.service.ts` | the queue projection, the list, the timeline, the version-checked claim, the reply target |
| `apps/api/src/conversations/timeline.ts` | inbound events and outbound commands merged by a read, paged by a signed cursor |
| `apps/web/src/api/conversations.ts` | the inbox client; two shapes, kept apart |
| `apps/web/src/live/realtime.ts` | dedupe, ordering, reset, and reconnection left to `EventSource` |
| `apps/web/src/live/inbox-actions.ts` | load, open, claim, reply, page back, subscribe |
| `apps/web/src/ui/live-inbox.ts` | the screen, in the design system's own vocabulary |
| `tests/e2e/support/api.ts` | the scripted API the layout and a11y suites measure against |
| `apps/web/src/live/inbox.test.ts` | 44 tests through the real client, actions and renderer |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 132.75 kB / 41.42 kB gzip |
| `pnpm test:coverage` | **0** | 81 files, **1437 tests**, 100% on all four metrics |
| `pnpm test:integration` | **0** | 21 files, **359 tests** against real PostgreSQL 17.4 |
| `pnpm test:contracts` | **0** | adapter + OpenAPI contract suites |
| `pnpm test:security` | **0** | isolation, authorization, signature, realtime suites + production audit |
| `pnpm test:e2e` | **0** | 136 |
| `pnpm test:a11y` | **0** | 23, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 17, images plus structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **53 operations**; the bidirectional drift test passes.

### Honest remaining scope

- **No Contacts.** There is no contacts table, so no contact panel, no consent view, no merge and no export. The customer panel is gone rather than present and empty.
- **No notes, labels, SLA, snooze, assignment to others, or unread counts.** Each was a demo affordance with no backend. They are removed rather than kept inert; a control that looks live and is not is worse than one that is absent.
- **Drafts live in memory.** A failed send keeps what was typed, and so does an unrelated re-render, but a reload loses it.
- **Broadcasts, Analytics and Settings are still seeded demos** and say so on screen.
- **Still no provider HTTP client and no broker product.** Every provider-live check stays `blocked_no_asset`; DEL-08/DEL-09 stay `blocked_env`.

---

## Previously completed — P1-T7 fifth slice (Milestone C: process roles, the broker relay, fairness, fencing and realtime)

**Task / requirement IDs:** DEL-08, DEL-09, DEL-18, DEL-19, DEL-20, IAM-11, IAM-12, IAM-13 closed. DEL-21, DEP-01, CMP-15 moved to `partial` with the unbuilt half named.

### Behavior delivered

**One artifact, eight roles.** `CONVO_PROCESS_ROLE` alone decides what a process is. An HTTP role listens; the five worker roles run a loop and **bind no port** — asserted by starting one and reading `null` from the server's address. The pool size follows the role rather than one global number. `worker-integration` **fails closed** when no durable broker is reachable: a process whose only job is publishing has nothing to do without one, and falling back to an in-memory queue would leave something that looks healthy, reports throughput, and loses everything it holds on restart.

**The broker is a transport; the outbox is the truth.** An envelope commits with the effect that caused it and is published afterwards, with `published_at` set only on a confirmation. The cost of that ordering is that a publish can happen twice, which is accepted rather than hidden: `broker_deliveries` makes consumers idempotent, so a duplicate is absorbed and a lost event would not be. Bounded retries end in `broker_dead_letters` with a reason; a replay creates a new envelope and records who did it.

**Fencing is enforced, not merely recorded.** `claim()` returns the version the worker owns and every result write compares it. The attempt row is still written **first and unconditionally** — a stale worker's provider response is evidence about what a customer may have received — and is marked `stale_dispatch` so it can never be mistaken for current state. Four stale paths tested: accept, `outcome_unknown`, rejection, retry.

**The round is bounded and dealt.** `planRound` serves interactive first up to the whole capacity, gives bulk the remainder, and deals within a class one slot at a time. Before this, every pending company got up to `concurrency` per tick, so the size of a tick depended on how many companies happened to be busy. The worker reports `offered` beside `achieved`, because `handled` alone reads the same whether a round served everything or a tenth of it.

**Realtime is an authorization feature that happens to have a transport.** Every event is decided again on the way out, by the same `authorize` the HTTP routes use, against a principal re-read from the database — so a revoked membership, a narrowed role or a removed inbox stops the stream on the next poll rather than at the next login. A caller who may only preview an unassigned conversation gets a **queue card built field by field on the server**; the test serialises the frames and asserts the transcript, the attachment name, the contact name and the raw phone number are nowhere in them. An event a caller may not see is omitted entirely rather than redacted.

**A cursor carries the authority it was issued under.** After a permission change, the events already delivered and the events skipped were both chosen against different rules, so a partial resume would be silently wrong; the answer is `reset_required` with `permissions_changed`. The other three unusable cases — `malformed`, `other_tenant`, `expired` — each have their own reason and their own test.

**The claim is atomic and version-checked.** Two agents claiming the same card concurrently produce exactly one 201 and one 409 `conversation_version_conflict`, asserted with two real requests issued together.

**Two defects the tests found.** The feed's `ORDER BY seq` bound to the `seq::text` output column and sorted 10 before 2 — invisible below ten events, then it walked the cursor backwards and re-delivered forever. And `reconcileReceipts` re-folded receipts it had already applied, turning a correctly-ordered `delivered` → `read` pair into a fabricated `delivered_after_read`; migration `0015` adds an observation watermark so each receipt folds once.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0013_broker_relay.sql` | the relay outbox, consumer idempotency, dead letters |
| `packages/database/migrations/0014_realtime.sql` | conversations, participants, the per-company counter, the append-only feed |
| `packages/database/migrations/0015_receipt_watermark.sql` | fold each receipt once |
| `packages/domain/src/channels/fairness.ts` | `planRound`: the reservation, the remainder, the round-robin |
| `packages/domain/src/realtime/visibility.ts` | who sees what, in what shape — built on the same `authorize` |
| `packages/domain/src/realtime/cursor.ts` | a position plus the authority it was issued under |
| `apps/api/src/broker/relay.service.ts` | confirm, retry with backoff, quarantine, replay |
| `apps/api/src/workers/worker-roles.ts` | what each role does per tick, through the scheduler |
| `apps/api/src/realtime/realtime.service.ts` | append in the caller's transaction; decide every event on read |
| `apps/api/src/realtime/realtime.controller.ts` | SSE with cursors, heartbeat, bounded lifetime |
| `apps/api/src/conversations/conversation.service.ts` | the queue projection, the version-checked claim |
| `tests/integration/api-realtime.test.ts` | 41 tests: projection, revocation, cursors, claims, receipts, the stream |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm test:coverage` | **0** | 82 files, **1528 tests**, 100% on all four metrics |
| `pnpm test:integration` | **0** | 22 files, **377 tests** against real PostgreSQL 17.4 |
| `pnpm test:contracts` | **0** | adapter + OpenAPI contract suites |
| `pnpm test:security` | **0** | isolation, authorization, signature, realtime suites + production audit |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 22, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 19, images plus structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **50 operations**; the bidirectional drift test passes.

### Honest remaining scope

- **No broker product.** The port, the relay, the confirms, the DLQ and the replay are real and tested against a scripted stub. Nothing is configured, so the default port answers every publish `unknown` with `broker_not_configured` — deliberately unknown rather than refused, so the outbox grows visibly. DEL-08/DEL-09 stay `blocked_env` on the live column.
- **No metrics endpoint.** `offered` and `achieved` are accumulated per loop and printed when a worker stops. A worker role binds no port, so there is nowhere else to put them yet.
- **No routing.** `conversations.team_id` exists and authorization reads it; nothing sets it except a test doing what a router will do.
- **No retention pruning.** The feed grows. What is built is the *client's* side of pruning: a cursor older than what is retained is refused with `expired` rather than silently resuming.
- **The Inbox, Contacts and the realtime UI are not built.** That is Milestone D, and it starts next.
- **Still no provider HTTP client.** Every provider-live check stays `blocked_no_asset`.

---

## Previously completed — P1-T7 fourth slice (Milestone C: the other four channel adapters)

**Task / requirement IDs:** CH-MSG-01, CH-MSG-02, CH-IG-01, CH-IG-03, CH-IG-04 closed. CH-00 and CH-01 gained four more adapters against the same versioned contract.

**Four channels, four sets of rules.** Messenger, Instagram, Website Chat and a versioned Custom Channel API, each with its own identity, capability matrix, window policy, template rules, signature scheme and event vocabulary. What the Meta three share is a *wire*, not a rule: one app secret, one envelope skeleton, one `entry[].messaging[]` walk. The tests assert the differences rather than the sameness — a WhatsApp template refused on all four others, 600 Arabic characters passing on Messenger and failing on Instagram, Instagram with no template path out of a closed window, and our own channels with no window at all.

**The ingress asks rather than switches.** Meta multiplexes three products over one webhook, so `adapterClaiming(payload, META_KINDS)` asks which adapter claims a verified envelope. Exactly one claims each, asserted; a delivery none recognises is acknowledged and journaled rather than retried forever.

**Our own channels carry the guarantees a provider would have given.** The installation signs deliveries with a key it issued — HMAC over `<timestamp>.<raw body>`, the timestamp inside the signed material so an old capture cannot be made to look fresh — with an exactly-matched origin allowlist and a per-connection rate limit beside it.

Committed as `bf36360`. Migration `0012_channel_settings.sql` adds the per-connection settings object the self-hosted channels are configured through.

---

## Previously completed — P1-T7 third slice (Milestone C: the outbound path)

**Task / requirement IDs:** DEL-07, DEL-10, DEL-12, DEL-13, DEL-14, DEL-15, DEL-16, DEL-17, SEND-01, SEND-03 closed. CH-WA-01, CH-WA-05, DEL-11, DEL-18, SEND-04, EVT-04 moved to `partial` with the unbuilt half named.

### Behavior delivered

**A command, an outbox, an attempt ledger, and two state machines.** `POST .../messages` answers **202** — durably queued, nothing sent — after the command and its outbox row commit together. There is no moment at which a caller has been told "queued" and nothing is scheduled to send it.

**`outcome_unknown` is a state, not an error.** A timeout or a reset means the request was on the wire and no answer came back. It leaves the outbox and stays visible; nothing automatic touches it again. Asserted by counting transport calls across a second dispatch sweep and a recovery sweep.

**The attempt row commits before the network call.** After a crash, recovery finds an attempt with no recorded response and marks it unknown rather than resending. Asserted by holding the transport open and observing the attempt mid-flight with a null outcome.

**The permit is re-evaluated at dispatch.** Four failing paths, each tested: the channel disconnected after queueing, consent withdrawn after queueing, the window shut before the dispatcher arrived, the credential revoked underneath. Each produces `skipped` with a typed reason rather than a send.

**Command and delivery state are separate columns.** Nine and three, folded by two different functions, with no ordering over the command states and no `max()` anywhere. A `delivered` arriving after a `read` leaves the timeline at `read` and records `delivered_after_read`.

**One conversation, one message on the wire.** `DISTINCT ON`, `NOT EXISTS`, an advisory lock for the window where a concurrent claim has not committed, and a partial unique index as the durable gate.

**A receipt that beats the send response is folded in the moment the provider id is learned**, because a receipt is an ordinary inbound event rather than a special case.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0011_outbound.sql` | suppressions, commands, the outbox with its dispatch gate, the attempt ledger |
| `packages/domain/src/channels/outcome.ts` | the three-valued classifier, the two state machines, `foldDelivery` |
| `apps/api/src/channels/outbound.service.ts` | 202 after the durable transaction; the command *is* the draft |
| `apps/api/src/channels/dispatcher.service.ts` | claim → re-permit → attempt → send → record, in that order |
| `apps/api/src/channels/outbound-request.ts` | the send parser; `clientMessageId` is the caller's, not ours |
| `tests/integration/api-channels.test.ts` | 88 tests, now including the whole outbound path |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | clean |
| `pnpm test:unit` | **0** | 56 files, 1027 tests |
| `pnpm test:integration` | **0** | 18 files, **257 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 74 files, **1284 tests**, 100% on all four metrics |
| `pnpm test:contracts` | **0** | adapter + OpenAPI contract suites |
| `pnpm test:security` | **0** | isolation, authorization, signature suites + production audit |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 22, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 19, images plus structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **43 operations**; the bidirectional drift test passes.

### Honest remaining scope

- **No provider HTTP client.** The send path is complete and exercised through a labelled stub; there is no Graph client, because there is no authorized app to build one against. Every provider-live check stays `blocked_no_asset`.
- **One adapter.** Messenger, Instagram, Website Chat and Custom Channel have matrices and policy, no adapter.
- **No broker.** The outbox is a database table drained in-process; DEL-08 and DEL-09 (relay, DLQ, audited replay) are not built.
- **No fairness scheduler.** `traffic_class` exists on every outbox row; the pool that would honour a reservation does not.
- **Fencing is recorded, not enforced.** `dispatch_version` increments on every transition but is not yet compared on write.
- **No realtime, no inbox, no contacts, no broadcasts, no CRM, no deployment configuration.**

---

## Previously completed — P1-T7 first and second slices (Milestone C: the channel foundation, the inbound path and the Channels screen)

**Task / requirement IDs:** CH-02, CH-03, CH-WA-02, CH-WA-04, DEL-02, DEL-05, DEL-06, EVT-01, EVT-02, EVT-03 closed. CH-00, CH-01, CH-05, CH-WA-03, CH-WA-05, DEL-01, DEL-03, DEL-04, DEL-07, DEP-01 moved to `partial` with the unbuilt half named. UX-09 gained its second wired screen.

### Behavior delivered

**One path, end to end.** Connect an asset → the provider delivers a signed webhook → the company is resolved from the asset inside it → the raw event is journaled → a normalized inbound event exists. 61 integration tests drive it against real PostgreSQL under FORCE RLS.

**A secret never sits in an ordinary column.** An app secret belongs to the installation, so `channel_apps` holds a *reference* to the configuration key it is read from plus a fingerprint of the value it was created against. A tenant's access token cannot live in configuration — it arrives from an OAuth grant — so it is AES-256-GCM ciphertext bound by additional authenticated data to its tenant, connection and purpose. A ciphertext lifted into another row does not decrypt; it breaks. Rotation appends a version and supersedes the previous one; there is no `DELETE` grant, because a revoked credential is evidence.

**The company comes from the payload, not the caller.** `channel_asset_registry` maps a provider asset to its owner across the whole installation, and its RLS policy admits exactly the row whose fingerprint the ingress derived from a signature-verified body. The test sends two forged tenant headers and asserts the receipt still records the real owner.

**A receipt and a payload are different facts.** `webhook_receipts` is installation-level, carries no content, and records every delivery including the refused ones — "we received bytes that failed to verify" is exactly what an operator needs when a provider claims it delivered. Content lives in a tenant-scoped row and only for a routable delivery: an asset nobody here has connected leaves a receipt, no content, and a 202.

**"Connected" is earned.** Five evidence timestamps, each written only by whatever observed it. `readinessOf` derives the state in one pure function the column and the screen share, so no endpoint can write `healthy`. A submitted form produces `authorization_needed` with four items missing.

**The ingress order is the design.** Raw bytes; HMAC over exactly those bytes, constant-time, with a replay window; company from the verified asset; journal; then ACK. Nothing is parsed until the signature holds — Nest's body parser is off and ours decides per route whether to parse or keep the buffer, because a signature over a re-serialized object verifies a document nobody signed.

**No simulator, deliberately.** The default transport refuses every send and connection test with `provider_not_connected`. One integration suite binds a labelled stub to exercise our own handling; it is bound nowhere in the shipped composition root.

**The Channels screen is wired, and the demo one is gone** — along with the `channel` demo action that answered four verbs with a warning toast. The token is dropped from form state whether the connect succeeds or is refused.

**The visual gate was broken and is fixed.** Replacing the Channels screen wholesale passed `toHaveScreenshot`. Measured: Arabic glyph jitter is ~1.4% of a text-dense screen and the replacement moved ~2%, so a pixel ratio cannot separate them. Every screen baseline is now paired with a **structural** snapshot — a DOM skeleton with all text removed — which rasterisation cannot move and a renamed action fails.

**Two gates stopped being `exit 1` echoes.** `test:contracts` and `test:security` are real. Wiring the audit found 9 high and 1 critical advisories in the HTTP stack — middleware and authentication bypasses in `@fastify/middie`, `fastify` and `@nestjs/platform-fastify` — and those are upgraded.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0010_channels.sql` | apps, connections, versioned credentials, the asset registry, receipts, events, the work queue, normalized inbound |
| `packages/database/src/context.ts` | the credential setting is a parameter now, so two carve-outs cannot widen each other |
| `packages/domain/src/channels/` | the versioned port, five capability matrices, the send policy, Meta signature verification, the WhatsApp normalizer |
| `apps/api/src/channels/credential-cipher.ts` | AES-256-GCM with a binding, a key version and an HMAC fingerprint |
| `apps/api/src/channels/ingress.service.ts` | verify → resolve → journal → ACK, in that order |
| `apps/api/src/channels/raw-body.ts` | one JSON parser; webhook routes keep the bytes |
| `apps/api/src/channels/normalization.service.ts` | the inbound worker, with a durable lease |
| `apps/web/src/ui/channels-screen.ts` | the screen; the demo one is gone |
| `tests/integration/api-channels.test.ts` | 61 tests: signature, replay, routing, dedupe, quarantine, isolation, lifecycle |
| `playwright.config.ts` + `tests/e2e/visual.spec.ts` | the structural snapshots that make the visual gate mean something |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 164.48 kB / 51.42 kB gzip |
| `pnpm test:unit` | **0** | 56 files, 984 tests |
| `pnpm test:integration` | **0** | 18 files, **230 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 74 files, **1214 tests**, 100% lines / statements / functions / branches |
| `pnpm test:contracts` | **0** | adapter + OpenAPI contract suites |
| `pnpm test:security` | **0** | isolation, authorization, signature suites + `pnpm audit --audit-level high --prod` |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 22, no WCAG 2.1 AA violations |
| `pnpm test:visual` | **0** | 19, now including structural snapshots |
| `pnpm test:mutation` | **1** | `not_run` — wired in P4 |
| `pnpm test:load:target` | **1** | `blocked_env` — k6 not installed, no staging target |
| `pnpm test:recovery` | **1** | `blocked_env` — no restore target |

The pinned OpenAPI carries **40 operations**; the bidirectional route/spec drift test passes. Coverage stayed at 100% with no threshold lowered and no exclusion added.

### Honest remaining scope

- **No outbound path at all.** No outbox, no delivery state machine, no `outcome_unknown` handling in a real send, no per-conversation ordering. `permitSend` exists and is tested but is not wired to a send, so CH-WA-05's "draft preserved" is untested.
- **One adapter.** Messenger, Instagram, Website Chat and Custom Channel have matrices and policy but no adapter; connecting one is refused with a typed `not_supported`.
- **One process.** The eight roles are configurable and the inbound worker is a service with a durable lease, but they are not separate deployed processes with their own queues.
- **No realtime**, no inbox, no contacts, no broadcasts, no CRM integration, no deployment configuration.
- **Every provider-live check is `blocked_no_asset`.** The signature scheme is genuinely verified against the documented algorithm; whether Meta's live deliveries match it needs an authorized app.

---

## Previously completed — P1-T5 fifth slice (Milestone B: the People screen, wired to the API)

**Task / requirement IDs:** UX-09 moved from `planned` to `partial` with the unwired screens named. IAM-14, IAM-15, IAM-16, IAM-24 gained their operator surface. API-02 incremental: two read models widened, one patch made genuinely partial.

### Behavior delivered

**The demo People screen was deleted, not left beside the real one.** Two implementations of one screen is how a demo ships by accident. `apps/web/src/ui/people-screen.ts` reads nothing from `data.ts`; the other five screens still do, and say so below.

**A list is a four-state resource**, not `data | null`: not asked, waiting, refused, here it is. "The server said no" and "there is nothing here" are different things to put in front of an operator, and a nullable field collapses them into one blank table. A denial renders as a permission state that says the refusal happened on the server — hiding a control is not an authorization control.

**Every mutation is pending → settle → toast.** Mark the specific control busy and re-render, await the server, then record success or the server's error. Nothing is written optimistically and no toast fires on click, because a toast on click is a claim the server has not made yet. `live.test.ts` holds a response open and asserts that the pending label is on the control, the button refuses a second click, and `state.toasts` is still empty — then that the toast appears only after the response commits. What is on screen after a change is what the reload returned, including fields the browser never asked about.

**Three defects the wiring exposed, all fixed at the cause:**

- Signing in resolved the session and stopped, so the lists sat on a skeleton until the operator reloaded by hand.
- A form key containing a colon (`teamMember:<id>`) collided with the `"<key>:<value>"` encoding the DOM uses to carry a form value, so the team-member select silently stored the wrong value under the wrong name. Both key builders are now in one place and asserted to contain no separator.
- `PATCH .../teams/{id}` demanded the team's name in order to archive it — which is how a team gets renamed by accident — and restoring a team whose name had since been reused returned a **500**. The patch is now partial (absent means "leave it alone", empty body is a 400), and the partial unique index's refusal is translated into the same `409 team_exists` the create path gives, by a shared helper that rethrows every other failure untouched.

**Two read models grew, for the same reason in both cases: a control existed with no honest way to reach it.** `GET .../teams` now returns each team's `members` and `archived` flag, so a card that said "3 members" can show who they are and remove one. The custom-role editor offers exactly the **delegable** keys from `GET .../permissions` instead of four hard-coded strings, and is disabled until a key and a scope are chosen — a convenience, not the control, since `canAuthorRole` still refuses on the server.

**One same-origin path in development and in production.** `apps/web/vite.config.ts` proxies `/api` to the running API, so the client only ever knows `/api/v1/...`. A second base URL that exists only locally brings a class of CORS and cookie bugs that never appear in the deployed build.

### Main files

| Path | Purpose |
|---|---|
| `apps/web/src/api/client.ts` | the HTTP boundary: results not exceptions, parsed error envelope, CSRF on every mutation |
| `apps/web/src/api/people.ts` | one named function per documented endpoint, plus `disconnectedApi()` |
| `apps/web/src/live/store.ts` | four-state resources, session state, `rowsOf` |
| `apps/web/src/live/actions.ts` | the pending/settle/toast discipline, in one place |
| `apps/web/src/live/dispatch.ts` | the `live-*` action table and the form-key vocabulary |
| `apps/web/src/ui/people-screen.ts` | the screen; the demo one is gone |
| `apps/api/src/pg-error.ts` | one named constraint violation → the API error it means |
| `apps/web/vite.config.ts` | `/api` proxy, so the browser path is the same in both environments |
| `apps/web/src/live/live.test.ts` | 37 tests driving the real client, actions and renderer over a scripted server |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | clean |
| `pnpm build` | **0** | web bundle 154.96 kB / 49.18 kB gzip |
| `pnpm test:coverage` | **0** | 71 files, **1007 tests**, 100% lines / statements / functions / branches |
| `pnpm test:unit` | **0** | 54 files, 838 tests |
| `pnpm test:integration` | **0** | 17 files, 169 tests against real PostgreSQL 17.4 |
| `pnpm test:e2e` | **0** | 146 |
| `pnpm test:a11y` | **0** | 22, no WCAG 2.1 AA violations |

The pinned OpenAPI still carries **32 operations**; the bidirectional route/spec drift test passes. Coverage reached 100% with no threshold lowered and no exclusion added: the remaining gaps were closed by deleting a dead helper (`scopeList`), replacing three copies of the same `status === 'ready' ? … : []` ternary with one tested `rowsOf`, and moving the untyped-`catch` guard into `pg-error.ts` where all three of its arms are asserted directly.

### Honest remaining scope

- **UX-09 stays `partial`.** Inbox, Channels, Broadcasts, Analytics and Settings are still backed by `data.ts`. A workspace that never opens People makes no request at all — asserted, not assumed.
- The People screen needs a running API to do anything. With none, it reports a network failure, which is what a page with no server behind it should show.
- No channel adapters, no webhooks, no realtime, no workers, no broadcasts, no CRM integration, no deployment configuration. No provider-live verification of any kind.

---

## Previously completed — P1-T5 fourth slice (Milestone B: the mutation surface)

Twelve routes behind CSRF: change a membership's role, status or scopes; create, replace and delete a custom role; create, rename, archive a team and move people in and out; offer, accept, decline and cancel ownership. None carries an `Idempotency-Key`, because none duplicates an effect on replay. Migration 0009 makes built-in roles and their grants immutable by admitting exactly the rows that already exist in `builtin_role_grants` — which permits the per-tenant seed, refuses an added key, a widened scope, an edit and a delete, **and** catches a seed that disagrees with the matrix. Ownership transfer is an offer the recipient accepts; offering requires `tenant.delete`, so "only an Owner may transfer" holds without any code naming the role. Every mutation writes an `admin_audit_events` row in the same transaction as its effect. Commit `a590d12`. Gates: 67 files, 940 tests, 100/100/100/100.

---

## Previously completed — P1-T5 third slice (Milestone B: invitations, and a 100% coverage gate)

**Task / requirement IDs:** IAM-06 closed. IAM-14 moved to `partial` with the enforced half named. DEP-14 restored to a real 100/100/100/100 gate.

### Behavior delivered

**The coverage gate is honest again.** Branch coverage was 98.95% against a threshold of 95, so it could rot to 95 without failing anything. It is now 100% and the threshold says 100. Six of the twenty-two uncovered paths were **deleted as unreachable** rather than covered — a non-nullable `ownerDocument` fallback, a finite-by-construction guard, an attribute re-read that `closestWithAttr` had already proved present, an optional parameter every caller passes, a campaign-example lookup whose fallback key cannot be missing, and a tab fallback the guard above it prevents. The rest were covered with tests for behaviour that genuinely happens.

**Invitations store a fingerprint, never a token.** Creation requires `member.manage`, CSRF and an `Idempotency-Key`, and authorizes **inside** the idempotency transaction rather than opening a second one, so the record and the invitation commit together. A retry replays the first answer; a second invitation for the same address supersedes the first, because two live tokens for one seat are two ways in.

**The ceiling is arithmetic, not a list of role names.** An Admin cannot invite an Owner because Admin does not hold `tenant.delete`. A scoped inviter cannot grant an inbox they cannot see.

**Acceptance needed a new tenancy primitive.** `FORCE ROW LEVEL SECURITY` applies to the table owner, so a `SECURITY DEFINER` lookup could not read the invitation either — the first attempt at one was removed. `withCredentialResolvedTenant` sets a transaction-local credential fingerprint that the policy admits for exactly the row carrying that token, takes `FOR UPDATE`, then enters the tenant's normal context. One row wide, not a flag that opens the table.

**Accept requires a password in both cases** — creating the identity, or proving it. Otherwise holding the link would attach a stranger's established account to a company. Unknown, expired, revoked, already-used and wrong-password are byte-identical, and a wrong password does not burn the invitation. A successful accept clears the attempt counter so an office behind one IP can onboard ten people.

**A visual-regression flake was fixed at the cause.** The seeded dataset derives timestamps from `new Date()` at boot, so baselines drifted with wall-clock time. Playwright's clock is frozen before the bundle runs.

### Main files

| Path | Purpose |
|---|---|
| `packages/database/migrations/0008_invitations.sql` | invitations, scopes, ownership-transfer offers, the one-row RLS carve-out |
| `packages/database/src/context.ts` | `withCredentialResolvedTenant` — tenant resolved from a verified credential |
| `packages/domain/src/iam/delegation.ts` | `canAssignRole` / `canAuthorRole` / `canGrantScopes` |
| `apps/api/src/people/` | invitation service, request parsing, delivery port, controller |
| `apps/api/src/require-row.ts` | the impossible-row guard, in one tested place |
| `tests/integration/api-invitations.test.ts` | 23 tests against real PostgreSQL |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects |
| `pnpm build` | **0** | |
| `pnpm test:coverage` | **0** | 65 files, **870 tests**, **100% lines / statements / functions / branches** |
| `pnpm test:integration` | **0** | 17 files, **156 tests** against real PostgreSQL 17.4 |
| `pnpm test:e2e` | **0** | 146 tests |
| `pnpm test:a11y` | **0** | 22 tests |

### Honest remaining scope

- **No email provider is configured**, so no invitation is actually delivered in production. Open dependency #9.
- The People/Roles/Teams **mutation** surface does not exist: role change, scope change, custom-role creation, team membership and ownership transfer are all still unimplemented. The `ownership_transfers` table exists but has no routes.
- There is **no People UI**. `apps/web` remains the demo; UX-09 stays `planned`.
- The invitation token travels in the URL path, as the task specifies. It is single-use, short-lived and rate-limited for that reason, and the OpenAPI description records that access logs must redact it.

---

## Previously completed — P1-T5 second slice (Milestone B: password recovery)

**Task / requirement IDs:** IAM-03 closed. API-02 incremental (two routes documented and drift-checked).

### Behavior delivered

**The start endpoint is not an oracle.** `POST /auth/recovery` always returns 202 with the same body — for a known address, an unknown one, and a rate-limited one. A 429 here would tell an enumerator they had found a real, rate-limited target, so the delay is advertised through the limiter and the existence of the account never is. The integration test compares the **whole response body byte for byte** rather than reading the code.

**A decoy challenge is written for an unknown address**, with a NULL user, so the table's shape and growth do not reveal which addresses are real. Nothing is delivered for it.

**Only fingerprints are stored.** The raw token exists long enough to hand to the delivery port and is never written, logged or returned. The database holds a 64-hex HMAC under a server secret, asserted directly.

**Completion is one transaction.** The challenge is claimed with a conditional UPDATE — two concurrent requests holding the same token cannot both win — then the password is replaced, every session for the account is revoked, and every other outstanding challenge is spent. A password change that leaves an attacker's session alive has changed nothing.

**Delivery is a port, and it is not wired.** `LoggingRecoveryDelivery` logs a redacted address and never the token, and deliberately does not throw: a recovery request must look identical whether or not delivery is configured. It is **not** an email integration and is recorded as unconfigured. `createApiApplication` now takes an `adapters` argument, because the composition root is where an outbound integration is chosen.

**A branch was deleted rather than tested.** The first implementation handled a decoy token in `complete()` with its own branch — code no request could reach, since decoy tokens are never delivered. The requirement moved into the claiming predicate (`AND user_id IS NOT NULL`), so a guessed decoy token is refused by exactly the same path as an unknown one. One path cannot drift from another.

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects |
| `pnpm build` | **0** | |
| `pnpm test:unit` | **0** | 46 files, **664 tests** |
| `pnpm test:integration` | **0** | 15 files, **111 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 61 files, **775 tests**, **100% lines / statements / functions**, 98.95% branches |

### Honest remaining scope

- **No email provider is configured.** The port exists and is exercised by a capturing adapter in tests; in production nothing is sent. A real adapter and its credentials are an open dependency.
- MFA (IAM-04) is not implemented, so recovery is the only account-recovery path.
- Invitations (IAM-06) remain `planned`.

---

## Previously completed — P1-T5 first slice (Milestone B: the role boundary)

**Task / requirement IDs:** IAM-09, IAM-10, IAM-15 closed. IAM-14, IAM-16, IAM-17 moved to `partial` with the enforced half named. IAM-03 and IAM-06 remain `planned` — see "Honest remaining scope".

### Behavior delivered

**The matrix exists once.** `packages/domain/src/iam/roles.ts` holds the seven built-in roles as data, transcribed from `business-rules.md` §7. `roles.test.ts` asserts every cell against that table *and* parses `packages/database/migrations/0007_role_matrix.sql`, so the module, the document and the database are held together by two mechanical checks rather than by discipline. Platform Super Admin is deliberately not one of the seven.

**Authorization is an intersection, and it can only narrow.** `packages/domain/src/iam/authorize.ts` implements invariant I3 as five sequential terms: active membership ∩ tenant status ∩ action grant ∩ delegation ceiling ∩ resource scope. No branch widens a decision. A `Principal` carries grants by key, not a role label, so there is nowhere to write `if (role === 'admin')`. 41 unit tests cover each term, `own` reached by assignment and by prior participation, lost inbox access overriding assignment, an empty ceiling meaning "nothing", and a 7-role × 29-key sweep.

**A defect the tests found.** The denial reason was originally derived from the grant level, so an agent who had lost inbox access was reported as `not_own_resource`. It now names the term that actually failed — the operator's next step and the audit line differ between "ask for the inbox back" and "this is not your conversation".

**Scope levels are stored.** Migration 0007 adds `scope_level` to `role_permissions`; until now a grant carried no scope and every grant behaved as tenant-wide. `none` is absent from the CHECK on purpose: a denial is the absence of a row.

**The last Owner is protected by the database.** `memberships_keep_an_owner` is a DEFERRABLE INITIALLY DEFERRED constraint trigger, not a service check — two concurrent transactions each removing "the other" Owner would both pass an application check. Deferring to commit is what makes a legitimate transfer (demote A, promote B) legal while committing with no Owner is not.

**One HTTP entry point to the engine.** `apps/api/src/authorization/authorization.service.ts` loads the principal inside the same RLS transaction the work runs in, so a membership revoked between check and write cannot be used. Non-membership, revoked membership and inactive tenant all conceal as 404; 403 is reserved for a member whose action is denied. `PermissionService` previously inlined its own `role.manage` query — correct for one route, and the start of a per-endpoint copy of the rules.

**Three routes, documented and drift-checked:** `GET /tenants/{tenantId}/roles`, `/people`, `/teams`. The pinned OpenAPI now also pins that `scope_level` admits only `tenant|scoped|own`.

### Main files

| Path | Purpose |
|---|---|
| `packages/domain/src/iam/permissions.ts` | the 29 keys and the non-delegable set, checked against migration 0003 |
| `packages/domain/src/iam/roles.ts` | the seven roles as data, checked against §7 and migration 0007 |
| `packages/domain/src/iam/authorize.ts` | the I3 intersection, field projection, queue-card allowlist |
| `packages/database/migrations/0007_role_matrix.sql` | `scope_level`, reference matrix, per-tenant seeding, last-Owner trigger |
| `packages/domain/src/installation/bootstrap.ts` | seeds all seven roles at company creation |
| `apps/api/src/authorization/authorization.service.ts` | principal loading and the single decision point |
| `apps/api/src/authorization/permission.service.ts` | permissions / roles / people / teams read models |
| `tests/integration/api-authorization.test.ts` | the database half: seeding, gating, concealment, last-Owner, pooled isolation |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects |
| `pnpm build` | **0** | all packages and the web bundle |
| `pnpm test:unit` | **0** | 46 files, **664 tests** |
| `pnpm test:integration` | **0** | 14 files, **98 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 60 files, **762 tests**, **100% lines / statements / functions**, 99.02% branches |
| `pnpm test:e2e` | **0** | 146 tests, unchanged |
| `pnpm test:a11y` | **0** | 22 tests, unchanged |

### Honest remaining scope after this slice

- **Password recovery (IAM-03) is still `planned`.** The hash-only schema from 0006 exists; there is no start/complete HTTP behaviour and no delivery port.
- **Invitations (IAM-06) are still `planned`.** No table, no routes.
- **Custom-role creation is not implemented.** The delegation ceiling is *enforced* by the engine, but there is no write path that mints a custom role, so IAM-14 is `partial`.
- **Ownership transfer is half done.** The transactional guarantee is proven; recipient acceptance, decline, expiry and the fresh-MFA gate are not built (IAM-16 `partial`, IAM-04 `planned`).
- **There is no People/Roles/Teams UI.** `apps/web` is still the demo from Milestone A and is not wired to these endpoints. UX-09 stays `planned`.
- `delegationCeiling` is `null` for every session principal, because API keys do not exist yet (P5).

---

## Previously completed — P1-T6 (Milestone A: the daily operator UI)

**Task / requirement IDs:** UX-01, UX-02, UX-03, UX-04, UX-05, UX-06, UX-07, UX-08, UX-10. UX-09 is deliberately **not** claimed — see "Honest remaining scope".

**Source state:** uncommitted working tree on `main` after `4d2b851`, extended in place. Nothing was reset, cleaned or discarded. macOS 25.6.0 arm64, Node v22.23.2, pnpm 9.12.0, PostgreSQL 17.4 in-process via `embedded-postgres`, Chromium 140.0.7339.16 via Playwright 1.55.0. No Docker.

### Behavior delivered in Milestone A

**One stylesheet architecture, one token layer.** `apps/web/src/styles.css` was a 3,668-line append-only monolith carrying **three** competing `:root` token blocks (lines 8, 2432, 3597), an `!important` tail and three font families. It is now a 29-line entry point that declares `@layer tokens, base, shell, components, screens;` and loads five files. No patch block was appended; the old monolith was replaced, not extended. The renderer was **not** migrated to React — the existing strict-TypeScript renderer was kept and extended, so the tree holds exactly one UI architecture.

**Colour is data, and contrast is a test.** `src/theme.ts` holds both palettes plus the WCAG requirement list; `src/theme.test.ts` parses `styles/tokens.css`, fails on drift, and re-checks **37 pairs on both themes** — 0 failures. It also proves the checker can fail (`contrastFailures` takes an injectable palette), forbids hard-coded colour outside the token layer, and forbids physical `left`/`right` in layout CSS. A dark theme exists for the first time.

**Typography.** One Arabic-first family, Readex Pro, self-hosted from `apps/web/public/fonts` under SIL OFL 1.1 with the licence text beside the files. No third-party font host is contacted, so a self-hosted install opens with no outbound call. Alexandria, IBM Plex Sans Arabic and Manrope are gone from the tree.

**Western digits at the formatter.** `numberFormat` / `dateFormat` in `src/format.ts` pass `numberingSystem: 'latn'` explicitly rather than relying on a `-u-nu-latn` locale extension, which is silently dropped when a caller passes a plain tag. `data.ts` no longer builds its own `Intl` instance. No fixture string was edited.

**Layout and density.** Shell is exactly `100dvh` with no page-level scrolling; rail 56px; top bar 48px; conversation header ≤64px on one row; queue rows a fixed 68px with a genuinely single-line preview; composer 117px at rest (cap 118) growing to 88px; both optional side zones closed on arrival; focus mode; `Escape` unwinds dialog → menu → side zones; the queue list is resizable 300–380px by pointer and by keyboard through a real `role="separator"`.

Whether an open side zone is an inline column or a drawer is decided in CSS by arithmetic from the 640px timeline floor — promotion at 1260 / 1364 / 1596px, drawers below 1027 / 719px — so the threshold exists once, not once in CSS and once in JavaScript. The viewport probe was removed from `app.ts` for exactly that reason.

**Defects found by measuring, then fixed.** The composer was 133px because `.composer__area` was laid out as a flex *row*, putting the toolbar beside the textarea. The queue showed 7 rows, not 8, because a wrapping filter bar cost 150px and a redundant meta strip cost another 28px. The timeline showed 6 groups, not 7.

**Defects found by looking at the screenshots, then fixed.** An Arabic customer message rendered with an LTR base direction inside the English UI, visually reordering the sentence — fixed with `unicode-bidi: plaintext` on customer content, and asserted by measuring where the first strong glyph lands. Queue-row cues were sheared mid-word — row anatomy is now capped at assignee plus two cues plus a count, with labels moved to the customer panel where the brief puts them. The thread header crowded out the contact name.

**Defects found by axe, then fixed in the DOM.** `role="list"` without `listitem` children; two scrollable regions with no keyboard access; an unstyled `.filterbtn` falling back to user-agent chrome that failed AA in dark; and an analytics bar chart painting its numeric label on the accent fill (a class mismapping — `.bars__value` is the label, `.bars__fill` is the bar).

### Main files

| Path | Purpose |
|---|---|
| `apps/web/src/styles.css` | 29-line entry: cascade order plus five imports, no declarations |
| `apps/web/src/styles/{tokens,base,shell,components,inbox,workspace}.css` | the five layers |
| `apps/web/src/theme.ts`, `theme.test.ts` | palette as data, contrast requirements, drift and contrast gate |
| `apps/web/src/format.ts` | `numberFormat` / `dateFormat` pinned to `latn` |
| `apps/web/src/app.ts` | Escape handling, pointer/keyboard list resize, composer auto-grow; viewport probe removed |
| `apps/web/src/state.ts`, `actions.ts` | side zones closed by default, focus mode, list-width clamp |
| `apps/web/src/ui/inbox.ts` | scrims, resizer, focus toggle, capped row cues, list semantics, focusable timeline |
| `apps/web/src/ui/workspace.ts` | marketing hero and KPI wall replaced by the shared compact header and `.metric` strip |
| `apps/web/public/fonts/` | Readex Pro subsets plus `Readex-Pro-OFL.txt` |
| `playwright.config.ts`, `tsconfig.e2e.json` | two mandated viewports, built bundle under test |
| `tests/e2e/layout.spec.ts` | 64 density and geometry assertions |
| `tests/e2e/a11y.spec.ts` | 22 accessibility checks, axe-core 4.10.2 |
| `tests/e2e/visual.spec.ts` | 19 baselines per viewport, 40 committed PNGs |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | four projects, including the new `tsconfig.e2e.json` |
| `pnpm build` | **0** | CSS 44.83 kB (7.70 kB gzip) |
| `pnpm test:unit` | **0** | 44 files, **580 tests** |
| `pnpm test:integration` | **0** | 13 files, **82 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 57 files, **662 tests**, **100% lines / statements / functions**, 98.97% branches (threshold 95) |
| `pnpm test:e2e` | **0** | **146 tests** across 1440×900 and 1366×768 |
| `pnpm test:a11y` | **0** | **22 tests**, 0 axe violations at wcag2a/2aa/21a/21aa |

No threshold was lowered and no exclusion was added. `apps/web/src/theme.ts` reached 100% only after `contrastFailures` was made palette-injectable so its failure path could actually execute.

Three placeholder scripts that previously exited 1 with `not_run` are now real runs: `test:e2e`, `test:a11y`, and the new `test:visual`. `test:contracts`, `test:security`, `test:mutation`, `test:load:target` and `test:recovery` still exit 1 honestly — their product surfaces do not exist yet.

`eslint.config.js` gained ignores for `tmp/`, `coverage/`, `playwright-report/`, `test-results/` and `deliverables/`. These are already in `.gitignore`; eslint 9's flat config does not read that file, and a scratch file under `tmp/` (not created by this task) was failing `pnpm lint`.

### Honest remaining scope after Milestone A

- **`apps/web` is still a client-facing demo.** UX-09 stays `planned`. Channel connection, invitations, team/member edits, campaign launch, exports and settings remain demo/no-op behaviour. Nothing in this milestone wired a UI action to a backend endpoint, and nothing here may be described as a live omnichannel product.
- No API surface changed, so `docs/api/openapi.v1.json` is unchanged and the bidirectional route/spec drift test in `tests/integration/api-contract.test.ts` passed unchanged. There was no drift to fix.
- UX-06 is `partial`, not `implemented`: this is AA-by-axe plus targeted manual assertions, not a full manual audit with a real screen reader.
- UX-01 and UX-10 stay `partial`: the Figma file is still HTTP 403 to automated fetch, so there are still **zero** `measured` token values and the licence could not be re-verified.
- Five of the nine mandated research URLs were blocked this session (two Chatwoot timeouts, two client-rendered Postman pages, one Meta 400). Recorded per-URL in `docs/design/ui-research.md` §5a. None of them blocks Milestone A; they matter to Milestone C.
- The visual baselines are `darwin`-tagged. A Linux CI run will need its own baselines or a container that matches the font rasteriser.

---

## Previously completed — P1-T4

**Task / requirement IDs:** local authentication, durable sessions and first permission boundary. IAM-01, IAM-02, IAM-05, IAM-07, IAM-08, API-02 (incremental), API-04, API-08, DEP-14. IAM-03 is schema-only and remains open.

**Source state:** uncommitted working tree on `main` after `4d2b851`; it contains P1-T2 through P1-T4. Do not discard or overwrite the dirty tree. macOS 25.6.0 arm64, Node v22.23.2, pnpm 9.12.0, PostgreSQL 17.4 started in-process by `embedded-postgres`. No Docker was used.

### Behavior delivered in P1-T4

- Migration `0006_auth_sessions.sql` adds durable sessions, centralized login-rate buckets, hashed recovery challenges and a minimal global membership discovery index. Session/CSRF/IP/user-agent values are stored only as separate HMAC-SHA-256 fingerprints; raw bearer material never enters PostgreSQL.
- `POST /api/v1/auth/login` verifies Argon2id passwords with a valid dummy hash for unknown accounts, returns the same generic 401 for unknown/wrong/inactive users, creates a 12-hour server-side session, and sets SameSite=Strict cookies. The session cookie is HttpOnly; both cookies are Secure under HTTPS.
- `POST /auth/logout`, `GET /auth/session`, `GET /auth/sessions`, `GET /auth/sessions/{id}` and `DELETE /auth/sessions/{id}` implement current-session and owner-scoped inventory/revocation. Mutations require a cookie/header CSRF match; revocation applies on the next request and persists across API restart.
- Account and IP login limits use atomic PostgreSQL upserts so replicas share one decision. The sixth failed attempt in a 15-minute window returns typed 429 plus `Retry-After`.
- `GET /me/memberships` uses the minimal discovery index only to find tenant contexts, then resolves active membership, company and role fields inside FORCE RLS. Suspended membership is hidden.
- `GET /tenants/{tenantId}/permissions` is the first protected company boundary. It conceals a nonmembership as 404 and checks `role.manage` by permission key under RLS; it never compares role display names.
- The pinned OpenAPI 3.1 document now matches all ten implemented routes in both directions and documents cookie auth, CSRF, rate limiting and closed response schemas.

The P1-T3 HTTP/bootstrap behavior below remains part of the working tree:

- `apps/api` is a NestJS 11/Fastify 5 process with one required role, `CONVO_PROCESS_ROLE=api`. Configuration is validated and aggregated before a pool is opened. Startup refuses an invalid mode and refuses a configured mode that differs from the mode already recorded in PostgreSQL.
- `GET /api/v1/instance` reads the real bootstrap state and returns only the allowlisted public descriptor. Integration tests assert that database credentials and both application secrets cannot appear in the response.
- `POST /api/v1/instance/bootstrap` creates the company and Owner synchronously and exactly once. The app hashes the password with Argon2id before calling the domain; the domain still rejects a non-hash. Domain failures map to typed 400/409/503 responses.
- Bootstrap requires an installer-provisioned `X-Bootstrap-Token` of at least 32 bytes. Missing and wrong values return the same 401 shape. Comparison uses fixed-length SHA-256 digests plus `timingSafeEqual`; the token is not written to PostgreSQL.
- Mutating bootstrap requests require `Idempotency-Key`. Migration `0005` stores pending/completed records under a `UNIQUE NULLS NOT DISTINCT` scope. FORCE RLS isolates tenant ledgers and exposes NULL pre-auth rows only while an explicit transaction-local installation scope is active. The transaction then switches to and verifies the generated tenant context before business writes. The effect and stored HTTP result commit together. Equal canonical bodies replay the first result; another body returns 409.
- The request fingerprint is HMAC-SHA-256 over recursively canonical JSON using a separate server secret. A database reader cannot use the stored fingerprint directly as an offline verifier for guessed owner passwords.
- Fastify generates or validates request IDs. Every failure path returns `{ error: { code, message, request_id, details } }`; synchronous creation returns 201 with `request_id`. Unknown framework/driver errors are reduced to safe public messages.
- `docs/api/openapi.v1.json` is the pinned OpenAPI 3.1 contract for every implemented route. A route inventory hook diffs real registered Fastify routes against the spec in both directions and also pins operation IDs, response codes, examples and closed response schemas.
- The canonical pagination utility produces the required `data/page/request_id` envelope and HMAC-signed opaque cursors bound to tenant, filters, sort, position and expiry. Tampering, wrong bindings, malformed cursors and expiry are covered before the first list route uses it.

### Main files

| Path | Purpose |
|---|---|
| `apps/api/src/app.ts`, `config.ts`, `api.module.ts`, `main.ts` | boot boundary, strict environment, process entry point |
| `apps/api/src/auth/`, `memberships/`, `authorization/` | login, session/CSRF boundary, shared rate limits, tenant membership resolution and permission enforcement |
| `apps/api/src/instance/` | public descriptor, authenticated first-run bootstrap, validation and response mapping |
| `apps/api/src/idempotency/` | canonical keyed fingerprint and transactional replay service |
| `apps/api/src/error.filter.ts`, `request-id.ts`, `pagination.ts`, `route-inventory.ts` | global HTTP contracts |
| `packages/database/migrations/0005_idempotency.sql`, `0006_auth_sessions.sql` | durable idempotency, session/recovery verifiers, abuse buckets and membership discovery |
| `docs/api/openapi.v1.json` | pinned contract source for implemented v1 routes |
| `tests/integration/api-auth.test.ts` | login, hashing, cookies, CSRF, memberships, allow/deny, restart, revocation and 429 journey |
| `tests/integration/api-instance.test.ts` | public descriptor, bootstrap auth, hashing, replay, concurrency and typed failures |
| `tests/integration/api-idempotency-rollback.test.ts` | injected completion-write failure proving effect and key roll back together |
| `tests/integration/api-boot.test.ts`, `api-contract.test.ts` | real boot/process behavior and route/spec drift |

### Evidence and checks

| Command | Exit | Result |
|---|---:|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | strict build graph plus tests project |
| `pnpm build` | **0** | all packages and API emitted |
| `pnpm test:unit` | **0** | 27 files, **217 tests** |
| `pnpm test:integration` | **0** | 13 files, **82 tests** against real PostgreSQL 17.4 |
| `pnpm test:coverage` | **0** | 40 files, **299 tests**, **100% lines / statements / functions / branches** |

The rollback fault test installs a trigger that deliberately rejects the update from `pending` to `completed`. The HTTP request returns a safe 500; the company, Owner and idempotency row are all absent; `bootstrap_state` remains `pending`; removing the fault and retrying the same key succeeds. This is the crash/atomicity evidence for API-05.

Two source entry points are excluded from in-process instrumentation: `packages/database/src/bin.ts` and `apps/api/src/main.ts`. Both are exercised as built child processes; all decidable logic behind them remains inside the 100% gate. The exact rationale is in [coverage-exclusions.md](../testing/coverage-exclusions.md).

### Honest remaining scope after P1-T4

- API-02 remains partial because the master inventory spans later phases. The drift test guarantees that every route implemented today is documented; it does not claim the future routes exist.
- API-08 remains partial until the first async 202 operation exists; the abuse-limited 429 path is implemented.
- DEP-01 remains partial until ingress, realtime and worker roles have separate processes and concurrency/queue configuration.
- IAM-03 recovery has a hardened hash-only schema but no start/complete HTTP behavior or delivery adapter yet. Invitations, MFA, the seven-role matrix, scope intersections, last-Owner protection and ownership transfer remain P1 work.
- DEP-02 still lacks a real expand/backfill/contract migration and cancellable throttled backfill. The migration runner itself is tested for apply, checksum, reapply and transactional failure.
- There are no channel adapters, inbox, broadcasts, frontend or deployment yet. There is no provider-live verification. The open external dependencies below do not block the next local P1 task.

---

### Previously

**P1-T3** — first NestJS/Fastify HTTP surface, bootstrap token and atomic HMAC-bound idempotency, request/error/pagination contracts and bidirectional OpenAPI drift protection.

**P1-T2** — closed DEP-14 at 100/100/100/100 without lowering thresholds; extracted the pure DB CLI, executed migration/bootstrap code in-process on throwaway databases, implemented validated installation mode and one-time bootstrap, and enforced the self-hosted one-company invariant in PostgreSQL.

**P1-T1 (commit `4d2b851`)** — workspace foundation, initial tenancy schema, runtime role and RLS harness. Closed with 18 PostgreSQL integration tests and the then-failing coverage gap reported honestly.

**P0 (commit `adf5462`)** — requirement registry, business rules, architecture and ADRs, data model, operation inventory, design-token evidence, testing strategy, threat model and provider evidence ledger.

---

## Open dependencies

These block only the named live/deployment checks. Independent implementation continues.

| # | Needed input | Blocks |
|---|---|---|
| 1 | Meta app, WABA, test phone number and authorized recipient | WhatsApp provider-live checks and authorized sends |
| 2 | Facebook Page, Instagram professional account and granted scopes | Messenger/Instagram provider-live checks |
| 3 | Odoo instance, version and service account | Odoo provider-live checks |
| 4 | Docker/OrbStack or reachable RabbitMQ and S3-compatible endpoint | broker/object-store contract checks |
| 5 | Disposable/staging infrastructure and k6 | load/soak SLO evidence |
| 6 | Figma connector authorization or exported reference in `docs/design/reference/` | measured design evidence; current tokens remain `estimated` |
| 7 | hosting region, domain, TLS and production authorization | deployment verification |
| 8 | OIDC identity provider | IAM-22 only; local auth proceeds |
| 9 | Email delivery provider and credentials | password-recovery **delivery** only; the port, the challenge lifecycle and every no-oracle guarantee are implemented and tested without it |

---

## Next task — P1-T10 (labels and typed custom fields)

**Task:** close the remaining local half of CON-08 and make the inbox/contact metadata filterable without accepting arbitrary untyped JSON as business data.

**Requirement IDs:** CON-08, CT-05, CT-11 and UX-09.

**Scope:**

1. A tenant-owned label catalogue, versioned assignment/removal operations and append-only audit evidence.
2. A typed custom-field catalogue with explicit value validation, active/retired lifecycle and safe indexing/search representation.
3. Server-side inbox and contact filters for labels and implemented typed fields, with tenant/scope authorization applied before counts and pagination.
4. Live Inbox and Contacts controls in Arabic/English, RTL/LTR and both themes; no local-only filter result or demo metadata mutation.
5. OpenAPI, migration, traceability, PostgreSQL isolation/race evidence and the full repository gate.

**Blocked, and stays blocked:** provider-live verification, production load and recovery evidence. None blocks this local slice.
