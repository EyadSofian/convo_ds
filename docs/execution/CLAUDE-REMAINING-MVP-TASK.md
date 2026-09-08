# Claude Code continuation prompt — finish the remaining CONVO product

You are continuing an existing implementation. Do not restart, redesign Milestone A, or claim the product is complete because the UI screenshots and local tests pass.

## Repository and current state

Work only in `/Users/eyad/Downloads/convo` (without a trailing space). Run `pwd`, `git status --short`, and `git log --oneline -12` first. Do not run `git reset --hard`, `git clean`, or discard the existing work.

Read these files before editing:

- `docs/execution/current-task.md`
- `docs/requirements/traceability.md`
- `docs/product/business-rules.md`
- `docs/architecture.md`
- `docs/api/operation-inventory.md`
- `docs/api/openapi.v1.json`
- `docs/research/provider-evidence.md`
- `docs/testing/strategy.md`
- `docs/security/threat-model.md`
- `docs/execution/CLAUDE-LIVE-MVP-TASK.md`

Milestone A (operator UI) and most of the role boundary are already implemented. Do not redo them. The current UI is still a demo because UX-09 is open. The remaining work must connect real screens to real API behavior.

## Non-negotiable engineering rules

1. Work in small, tested milestones. After each milestone update `current-task.md` and `traceability.md` with exact evidence.
2. Preserve PostgreSQL FORCE RLS, idempotency, CSRF, safe error envelopes, signed cursors and permission-key authorization. Never replace server authorization with a UI check.
3. Do not lower a threshold, add a broad coverage exclusion, weaken RLS, or turn an unreachable path into fake coverage.
4. A provider simulator or fixture is not a live provider connection. Keep live checks `blocked_no_asset` until authorized assets and observed webhook/send evidence exist.
5. A button that only changes `localStorage`, `setTimeout`, or demo state does not count as implemented. Every production action must call a documented endpoint and handle loading, success, error, retry and permission states.
6. Keep tenant isolation, field projection and inbox privacy enforced by the API and database. An Agent must never receive another inbox's transcript and then hide it in the browser.

## Milestone B remainder — finish People, invitations and mutations

Implement and test the following before starting channels:

### Invitations

- Add tenant-scoped invitation and invitation-scope tables with FORCE RLS, hashed single-use token fingerprints, expiry, revoke, accepted timestamp, creator membership, target email, role and requested scopes.
- `POST /api/v1/tenants/{tenantId}/invitations` requires `member.manage`, CSRF and `Idempotency-Key`.
- `GET /api/v1/tenants/{tenantId}/invitations` is scoped and paginated.
- `POST /api/v1/invitations/{token}/accept` is atomic: create or resolve the global user, create exactly one membership, assign only the permitted role/scopes, mark the invitation accepted, and reject reuse/expiry/revoke with the same safe response shape.
- Do not reveal whether a target email already belongs to a tenant. Never return raw invitation tokens in API responses or logs. Deliver through an injectable port; a real email provider may remain an explicit environment dependency.

### Membership, role, team and ownership mutations

- Change a membership role, status and scopes only within the actor's delegation ceiling.
- Create/edit/delete custom roles only with delegable permission keys the actor already holds. Built-in roles are immutable.
- Create/update/archive teams and add/remove memberships, with tenant and scope checks.
- Implement ownership transfer with recipient acceptance, expiry, decline, recovery path and fresh-MFA gate when MFA exists. Preserve the deferred database last-Owner constraint.
- All replayable mutations use idempotency; all browser mutations use CSRF; all responses use the existing error and request-id envelope.
- Add OpenAPI operations and a bidirectional route/spec drift test.

### People UI

Wire `apps/web` People, Roles and Teams screens to these endpoints. Implement real forms/drawers for invite, role change, scope selection, team assignment, revoke/suspend, custom role creation and ownership transfer. Show server errors and pending states; do not show a success toast before the response commits.

Add unit, PostgreSQL integration, security and E2E tests for invite creation, unknown/expired/revoked/reused acceptance, cross-tenant access, delegation ceilings, last Owner, concurrent mutations, CSRF and idempotent replay.

## Milestone C — real omnichannel foundation

Build a provider-neutral channel port and independent adapters. The browser must call the CONVO API; it must never call Meta directly.

### Channel connections

Implement connection records, encrypted/redacted credentials, per-asset tenant mapping, capability snapshots, connection health, credential rotation and safe disconnect/reconnect. Provide backend operations for the Channels screen: create, authorize, callback, test, reauthorize and disconnect.

Implement separate adapters and policies for:

- WhatsApp Cloud API: WABA, phone asset, webhook subscription, templates, consent and response-window rules.
- Facebook Messenger Page messaging: Page token, scopes, recipient identity and independent policy.
- Instagram professional messaging: separate login/scopes, customer-initiated rule, identity and webhook policy.
- Website live-chat widget with signed installation identity, origin allowlist and rate limits.
- Custom Channel API with a versioned adapter contract.

For every adapter:

- Verify raw-body webhook signatures and reject stale/replayed events.
- Resolve tenant from the verified channel asset, never from a caller-supplied tenant header.
- Persist inbound events before acknowledgement, deduplicate provider event IDs, handle out-of-order delivery and process asynchronously.
- Use an outbox and worker state machine for outbound messages. Distinguish accepted, sent, delivered, read, failed, not_available and outcome_unknown.
- Never send private notes to a provider. Never reuse a WhatsApp template as a Messenger or Instagram template.
- Add deterministic provider simulators, fixtures, contract tests, retry/backoff/rate-limit tests, reconnect tests and ambiguous-timeout tests.

Add separate process roles/configuration for `api`, `ingress`, `realtime`, inbound workers, interactive workers, campaign workers and integration workers. Keep the app safe if RabbitMQ/object storage is unavailable; record the dependency instead of silently using an in-memory queue in production.

## Milestone D — real inbox, contacts and realtime

Implement the backend and wire the existing compact UI:

- Inbox list/detail/message APIs with cursor pagination and all required filters.
- Per-user read cursors, unread counts, assignment, atomic claim, team routing, labels, priority, SLA state, notes, attachments metadata, status transitions, disposition and snooze wake jobs.
- One active conversation per tenant/inbox/contact identity enforced by a database constraint or serialized transaction.
- Contacts with multiple channel identities, nullable phone, consent proof, suppression, import validation and audited merge.
- Realtime subscriptions with authorization and projected unassigned payloads. Revoked membership or inbox access must immediately stop delivery.
- Public reply/private note behavior, channel-window enforcement and preservation of a draft after a typed send rejection.

Add E2E coverage for login → scoped inbox → receive → claim → reply → provider status update → resolve, including Agent isolation and Unassigned projection.

## Milestone E — broadcasts, campaigns and reports

Replace every campaign no-op with a real state machine:

- Draft, version, audience builder, saved segment, channel-specific approved template, dry run, schedule/timezone, quiet hours, approval, launch, pause, stop, duplicate and audit history.
- Snapshot eligibility and recheck at dispatch for consent, suppression, template status, channel health/window, scope, entitlement, budget and stop version.
- Immutable execution and recipient ledger with attempts, provider IDs, timestamps and reasons.
- Stop only undispatched work; never claim an already accepted provider request was recalled.
- Reports for volume, response/resolution time, SLA, agent/team/channel workload, campaign funnel, failure reasons and export jobs. Apply permission and scope on the server.

Wire Broadcasts and Analytics to the campaign APIs. Remove demo `launch`, `export` and local-only success paths.

## Milestone F — CRM, APIs, verification and Railway

- Implement an Odoo adapter behind a version-detected port and a generic CRM integration contract. Add simulator/contract tests when credentials are unavailable.
- Finish API keys, webhook management, integration health, audit events and safe secret rotation as required by the operation inventory.
- Replace remaining placeholder scripts that are now unblocked: `test:contracts`, `test:security`, `test:mutation`, `test:e2e`, `test:a11y`, `test:visual`, `test:load:target`, and `test:recovery`. A script may remain blocked only when its external environment truly does not exist, and the ledger must say why.
- Require the full meaningful gate: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:coverage`, `pnpm test:e2e`, `pnpm test:a11y`, contract tests, security tests, mutation tests and staging load/recovery checks. Restore branch coverage to the repository's required target; do not accept 98.95% as a claimed 100% gate.
- Configure Railway service/process commands, migration job, readiness/health checks, required environment schema, PostgreSQL, RabbitMQ, object storage, log redaction, backups and rollback. Deploy only if Railway is authenticated and all available gates pass.

## Completion report

At the end of every milestone, report:

- exact changed files;
- exact commands, exit codes and test counts;
- updated OpenAPI and traceability evidence;
- external assets still required;
- behaviors that are simulator-tested but not provider-live;
- the next unblocked task.

Do not finish by saying “the UI is ready” while any button is still a demo no-op. Start with the Milestone B remainder now, then continue automatically into Milestone C and the next unblocked milestone.
