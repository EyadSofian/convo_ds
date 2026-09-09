# Claude Code task — Milestone C real omnichannel foundation

Continue the existing CONVO implementation in `/Users/eyad/Downloads/convo`.

Do not redo Milestone A UI or the completed People/Roles/Teams work. Do not restore demo screens beside the real screens. Read `docs/execution/current-task.md`, `docs/requirements/traceability.md`, `docs/product/business-rules.md`, `docs/architecture.md`, `docs/api/operation-inventory.md`, `docs/api/openapi.v1.json`, `docs/research/provider-evidence.md`, the ADRs for ingress/delivery/reliability, and `docs/execution/CLAUDE-REMAINING-MVP-TASK.md` first.

Run `pwd`, `git status --short`, and `git log --oneline -12`. Never reset, clean, or discard the existing work. Keep one UI architecture and preserve the current 100/100/100/100 coverage gate.

## Goal

Build the backend channel foundation and connect the Channels screen to real API operations. The browser must call CONVO APIs; it must never call Meta directly. Provider simulators and fixtures are required for deterministic tests, but they are not provider-live verification.

## 1. Data model and security boundary

Add migrations with tenant FORCE RLS and least-privilege grants for:

- channel connections and verified provider assets;
- encrypted/redacted credential references and credential rotation metadata;
- channel capability snapshots and health state;
- webhook subscriptions, raw event fingerprints, dedupe keys and processing state;
- normalized inbound events, outbound attempts and provider status events;
- outbox records and worker lease/retry state;
- channel-specific templates and consent/window policy evidence.

Every provider asset must have its own connection ID and tenant mapping. Never use a caller-supplied tenant ID or header as authority. Secrets and raw tokens must never enter logs, API responses, fixtures, snapshots or ordinary database columns.

Add indexes/constraints for idempotent provider-event ingestion, one active connection where appropriate, credential versioning and safe retry ownership. Test pooled connection reuse and cross-tenant reads/writes against real PostgreSQL FORCE RLS.

## 2. Provider-neutral ports and adapters

Create a versioned channel adapter port with explicit capabilities, policy decisions, normalized events and typed failure reasons. Each adapter must expose connection validation, webhook verification, inbound normalization, outbound send, status normalization and health check.

Implement independent adapters/configuration for:

1. WhatsApp Cloud API: WABA, phone asset, webhook subscription, approved templates, consent and customer-service window.
2. Facebook Messenger Page messaging: Page asset, page-scoped identity, scopes and eligible-message window.
3. Instagram professional messaging: its own login/scopes, professional account identity, customer-initiated rule and window.
4. Website live-chat widget: signed installation identity, origin allowlist, rate limit and conversation continuity.
5. Custom Channel API: documented versioned contract for an additional channel.

Do not share channel policy or templates between WhatsApp, Messenger and Instagram. A WhatsApp template must never be accepted for Messenger or Instagram. Unsupported capabilities return typed `not_supported` or `not_available`; they must not be queued to fail later.

## 3. Ingress and outbound reliability

Implement separate process roles/configuration for `api`, `ingress`, `realtime`, `worker-inbound`, `worker-interactive`, `worker-campaign` and `worker-integration`.

Inbound path:

1. Receive the raw request.
2. Verify the provider signature and replay window before tenant resolution.
3. Resolve the tenant only from the verified channel asset.
4. Persist the event and dedupe key before acknowledging.
5. Enqueue normalized work durably.
6. Process out of order and redelivery safely.

Outbound path:

1. Authorize action, tenant, inbox, consent, identity, channel window, template, rate limit and budget at permit time.
2. Write an outbox record transactionally with the domain effect.
3. Claim work with a durable lease and bounded retry/backoff.
4. Persist provider request IDs and status transitions.
5. Distinguish `accepted`, `sent`, `delivered`, `read`, `failed`, `not_available` and `outcome_unknown`.
6. Never blindly resend an ambiguous provider timeout.

Private notes must never reach an outbound provider. A rejected/expired channel-window reply must preserve the draft and change no conversation state.

## 4. HTTP API and Channels screen

Add all operations to the pinned OpenAPI contract and enforce route/spec drift in both directions:

- list connections and capabilities;
- create/connect/authorize/callback;
- test connection;
- reauthorize/rotate credential;
- disconnect/revoke;
- webhook health and recent event status.

All mutations require authenticated membership, permission-key authorization, CSRF and idempotency where replay could duplicate an effect. Return request IDs and safe closed response shapes.

Wire `apps/web` Channels to these endpoints. Remove the existing demo `channelAction` behavior. Show evidence-based states only: `not_configured`, `authorization_needed`, `webhook_pending`, `healthy`, `degraded`, `disconnected`, and `provider_not_connected`. The UI must show loading, error, retry and permission-denied states and must not display “Connected” before the backend has all required evidence.

## 5. Deterministic tests

Add unit and real-PostgreSQL integration tests for:

- signature verification, stale/replayed webhook rejection and provider-event dedupe;
- tenant resolution from verified assets and forged-tenant-header rejection;
- out-of-order events and redelivery;
- channel capability and window policy for every adapter;
- consent withdrawal and suppression at dispatch time;
- private-note non-delivery;
- ambiguous timeout handling and no blind duplicate send;
- credential rotation/disconnect blast-radius isolation;
- RLS and inbox/tenant isolation;
- idempotent connect, disconnect, callback and webhook processing;
- Channels UI loading/error/health/permission states and no premature success toast.

Use provider simulators and fixtures for all deterministic tests. Record provider-live verification as `blocked_no_asset` until the project receives an actual Meta app, WABA, test phone, Facebook Page, Instagram professional account and authorized recipient.

## 6. Gates and evidence

Run and pass:

```text
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:coverage
pnpm test:contracts
pnpm test:security
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
```

Keep lines, statements, functions and branches at the required 100% gate without lowering thresholds or adding broad exclusions. If a command is genuinely blocked by missing external infrastructure, make that blocker explicit and still complete every simulator-backed and local check.

Update `docs/execution/current-task.md`, `docs/requirements/traceability.md`, `docs/research/provider-evidence.md`, `docs/api/openapi.v1.json`, `docs/api/operation-inventory.md`, and `docs/database/erd.md` with exact files, counts, exit codes and live-vs-simulator status.

Start now with the schema and provider-port audit, then implement the first complete connection → webhook → normalized event path. Continue through the next unblocked adapter and do not stop at a design review or a demo-only screen.
