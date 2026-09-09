# Claude Code task — complete the remaining Milestone C transport system

Continue inside `/Users/eyad/Downloads/convo`. Read `docs/execution/current-task.md`, `docs/requirements/traceability.md`, `docs/product/business-rules.md`, `docs/architecture.md`, `docs/research/provider-evidence.md`, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0008 and the existing channel/outbound implementation first.

The WhatsApp-shaped channel foundation, inbound path, Channels screen, and outbound command/outbox/attempt path already exist and are committed. Do not redo them or reintroduce demo behavior. Preserve the current 100/100/100/100 coverage gate and all existing tests.

The current outbound contract is binding:

- `POST .../messages` returns 202 only after the command and outbox row commit together.
- Dispatch rechecks permission, channel health, consent, window and credential state at permit time.
- The attempt row commits before the network call.
- `outcome_unknown` is durable and is never automatically retried.
- Command state and delivery state remain separate.
- Receipt folding is monotonic and records contradictory late receipts as evidence.

## 1. Finish the remaining channel adapters

Implement the same port contract used by the existing channel foundation for:

1. Facebook Messenger Page messaging.
2. Instagram Professional Messaging.
3. Website live-chat widget.
4. Versioned Custom Channel API.

Each adapter must have independent identity, capability matrix, response-window policy, consent rules, template rules, webhook signature verification, normalized inbound events, outbound transport, status mapping and health checks. Do not share WhatsApp rules or templates across channels.

For Meta adapters, implement provider-client interfaces and deterministic HTTP fixtures/mocks now. Do not fabricate credentials, Graph versions, scopes, or successful live responses. Keep provider-live evidence `blocked_no_asset` until the project receives an authorized Meta app, WABA/phone, Page, Instagram account and recipient.

For Website Chat, implement signed installation identity, origin allowlist, rate limit, message ingestion and continuity. For Custom Channel, publish the versioned contract, validation rules, signing requirements and capability negotiation.

Add unit, integration and adapter-contract tests for every supported capability and every unsupported path. Test that a channel's template/window/consent policy cannot be accidentally reused by another channel.

## 2. Realtime authorization and delivery

Implement the realtime process and authenticated subscription protocol:

- authorize the tenant, inbox, team and conversation before subscribing;
- derive tenant from the authenticated session and membership, never from a client payload;
- project unassigned conversations to the restricted queue-card shape only;
- never emit transcript, contact PII, notes or attachments to an Agent before an atomic claim;
- revoke or narrow subscriptions when membership, role, team or inbox access changes;
- deduplicate events, preserve event ordering metadata, and safely reconnect from a cursor;
- make provider status, assignment, read state, notes and conversation state separate event types.

Add tests for unauthorized subscriptions, cross-tenant channels, revoked memberships, inbox removal, reconnect, duplicate events, stale cursors, out-of-order receipts and restricted unassigned projections.

## 3. Separate workers and broker relay

Create separately configured process entry points for:

- `api`
- `ingress`
- `realtime`
- inbound worker
- interactive outbound worker
- campaign worker
- integration worker

Use RabbitMQ or the configured durable broker behind a port. Add the broker relay, publisher confirms, consumer acknowledgements, redelivery handling, dead-letter exchange/queue, bounded retry policy, poison-message quarantine and operational health metrics. A process must fail closed if the durable broker is required but unavailable; it must not silently fall back to an in-memory queue in production.

Workers must be restart-safe and idempotent. Persist a lease/fencing token for every claimed job. A stale worker must be unable to write a result after a newer worker owns the job.

## 4. Fairness and fencing

Complete the delivery rules that are currently partial:

- implement the fairness scheduler that honors `traffic_class` across tenants, channels and interactive/campaign work;
- guarantee that one noisy tenant or channel cannot starve interactive customer replies;
- use bounded queues and explicit offered/achieved metrics;
- compare `dispatch_version` on every result write, not only increment it on transitions;
- reject stale attempts/results with a typed reason while preserving the provider evidence;
- prove retry, worker restart, lease expiry, fencing conflict and DLQ behavior against PostgreSQL.

Add property tests for fairness and every permutation of delivery receipts. Keep `outcome_unknown` untouched by recovery sweeps unless an explicit operator action creates a new attempt.

## 5. HTTP and UI completion

Update the pinned OpenAPI document and route-inventory test for all new operations. Wire the existing Channels screen to the real connection, health, webhook and provider-test endpoints. Remove any remaining local-only success path. Keep loading, permission-denied, degraded, disconnected and provider-not-connected states distinct.

Do not change the already-passing People/Roles/Teams or Inbox visual architecture unless an integration requires a small, tested change.

## 6. Gates and evidence

Run:

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

Add meaningful tests for new branches rather than lowering thresholds or adding broad exclusions. `test:mutation`, `test:load:target` and `test:recovery` may remain blocked only with an explicit environment reason and ledger entry; implement local deterministic portions wherever possible.

Update `current-task.md`, `traceability.md`, `provider-evidence.md`, `openapi.v1.json`, `operation-inventory.md`, `erd.md` and the README with exact files, test counts, exit codes, simulator/live status and remaining assets.

Start with the Messenger adapter and the shared adapter contract audit, then continue automatically through Instagram, Website Chat, Custom Channel, realtime, broker relay, workers, fairness and fencing. Do not stop at a design document or a mocked success screen.
