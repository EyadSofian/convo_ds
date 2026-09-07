# CONVO — Architecture

Status: P0 baseline, 2026-09-07. Decisions with consequences are recorded as ADRs in `docs/adr/`; this file is the map, not the debate.

## 1. Shape

**A modular monolith with separately scalable process roles.** Not a microservice per table. Domain modules share explicit contracts and one transaction service; deployment roles differ in concurrency, queue bindings and resource ceilings, and may share one image.

```
                    ┌──────────────┐
  Meta webhooks ───▶│  ingress     │──┐   (verify raw-byte signature, journal, ACK)
                    └──────────────┘  │
                                      ▼
  Browser (SPA) ───▶┌──────────────┐  ┌──────────────────┐
                    │  api         │─▶│  PostgreSQL      │◀── source of truth
  Public API   ───▶ │  (Fastify)   │  │  + RLS + outbox  │
                    └──────────────┘  └──────────────────┘
                                      │        ▲
  WebSocket    ───▶┌──────────────┐   │        │
                   │  realtime    │◀──┤        │
                   └──────────────┘   ▼        │
                                   ┌──────────────────┐
                                   │  outbox relay    │──▶ RabbitMQ (quorum)
                                   └──────────────────┘         │
                                                                ▼
                 ┌────────────┬────────────┬────────────┬───────────────┐
                 │ inbound    │ interactive│ campaign   │ integration / │
                 │ workers    │ send       │ planner +  │ export /      │
                 │            │ workers    │ dispatcher │ media workers │
                 └────────────┴────────────┴────────────┴───────────────┘
                                                                │
                                   ┌─────────────┐              ▼
                                   │  services/ai│      Meta Graph / Odoo / S3
                                   │  (Python)   │
                                   └─────────────┘
```

Redis/Valkey is **ephemeral only**: rate-limiter coordination, presence, short-lived caches, socket fan-out hints. It is never the sole durable record of an accepted command, campaign, consent or ownership transition.

## 2. Process roles

| Role | Scales on | Must never |
|---|---|---|
| `api` | request rate, DB pool | Do provider I/O inside a request transaction |
| `ingress` | webhook rate | Do CRM/AI/media work before ACK |
| `realtime` | open sockets | Broadcast on a global wildcard topic |
| `worker:inbound` | normalization lag | Drop a batch because one element is unsupported |
| `worker:interactive` | oldest queue item | Share a pool with bulk campaign traffic |
| `worker:campaign` | recipient backlog | Load a full audience into memory |
| `worker:integration` | CRM lag | Block the inbox when Odoo is down |
| `worker:media` | scan queue | Fetch a non-allowlisted host |
| `ai` (P7) | run concurrency | Be a hard dependency of login or messaging |

Each role gets its own concurrency, prefetch, `max_in_flight` and resource ceiling. Adding workers is bounded by DB pool utilization and provider limits — never presented as raising a Meta limit.

## 3. Repository layout

```
apps/web         React + TS strict + Vite + TanStack Query + virtualization
apps/api         NestJS on Fastify, TS strict, Node 22 LTS
apps/ingress     Minimal webhook receiver (own deployment, own budget)
apps/realtime    WebSocket gateway + catch-up cursor API
apps/worker      All worker roles, selected by ROLE env
services/ai      Python, PydanticAI, Temporal workflows (P7)
packages/contracts     OpenAPI + generated types + event schemas
packages/domain        Framework-independent business logic
packages/database      Migrations, RLS policies, typed query layer
packages/authz         Permission keys, scope intersection, policy engine
packages/channel-adapters  WhatsApp / Messenger / Instagram + simulator
packages/integrations  Odoo + generic connector contract
packages/ui            Design system, tokens, Storybook
packages/observability OTel setup, redaction, metric helpers
infra/compose          dev profile + hardened single-host production profile
infra/helm             HA topology for SaaS and self-hosted HA
tests/{integration,contracts,e2e,load,security,fixtures}
docs/{adr,requirements,product,api,database,design,testing,security,runbooks,execution,evidence}
```

Domain modules: Tenancy/IAM, Channels, Inboxes, Contacts/Identity/Consent, Conversations, Messaging/Delivery, Campaigns, Routing/SLA, Automation, Integrations, Analytics/Usage, AI.

Hard rules: no frontend direct DB access; no ad-hoc tenant filters scattered outside the policy/transaction boundary; no synchronous CRM/LLM/media download in the webhook ACK path; no unbounded in-memory fan-out.

## 4. Data durability boundaries

| Concern | Durable store | Notes |
|---|---|---|
| Raw provider events | Postgres journal | Written **before** ACK; replayable subject to retention |
| Domain state | Postgres | RLS + composite FKs |
| Work handoff | Postgres outbox → RabbitMQ | Publish marked only after broker confirm |
| Recipient/attempt ledger | Postgres | Queue carries small refs only |
| Idempotency records | Postgres | Retained for the operation lifetime, not a fixed short TTL |
| Media | S3-compatible | Quarantine → scan → signed short-lived access |
| Presence, rate coordination | Redis/Valkey | Loss is acceptable; never fail-open on budget/consent |
| Search | Postgres FTS first; OpenSearch when measured need | Arabic analyzer leg + dense retrieval later |
| Vectors | pgvector | Isolated resource budget from interactive DB |

## 5. Failure semantics in one page

**Inbound:** verify raw bytes → resolve tenant from the *verified asset* → persist journal → ACK. Normalize with schema version + provider-specific dedupe. Apply domain change + outbox event in one transaction. Publish, confirm, mark. Consumers are idempotent because a crash between publish and marker legitimately produces duplicates.

**Outbound:** authenticate/authorize → validate → idempotency check → write command+message+operation+outbox atomically → 202 with stable IDs. Dispatcher claims bounded work, rechecks everything at permit time, records a durable attempt **before** the network call, then classifies the outcome as `accepted` / `definitely_rejected` / `outcome_unknown`.

Twelve tracked states, with command state and provider delivery state stored separately: `queued, dispatching, provider_accepted, sent, delivered, read, rejected, retry_scheduled, skipped, cancelled, failed, outcome_unknown`. Transitions are explicit; there is no "take the integer max" folding. Late delivery never rolls back read; a conflicting failure never erases confirmed delivery.

**Ordering:** per-conversation ordering via a serialized dispatch gate with fencing tokens and durable versions. Bounded lock lifetimes with recovery. A stale worker cannot publish authoritative state or send an obsolete bot command. Global cross-provider ordering is not claimed.

## 6. Security architecture

- Postgres RLS with USING **and** WITH CHECK, FORCE RLS where appropriate, transaction-local verified tenant context, pooling-safe. Runtime role is not owner/superuser/BYPASSRLS. Migration role is separate. RLS is defence in depth *behind* object/action permissions, not instead of them.
- Isolation extends to cache keys, socket subscriptions, object-storage paths, search indexes and snippets, exports, logs, metric detail endpoints, backups, AI retrieval and tool calls.
- Sessions are secure HttpOnly cookies with CSRF protection. No provider credentials, API-key secrets or long-lived bearer tokens in browser storage or logs. If a short-lived access token is ever needed, it lives in memory only.
- Secrets: encrypted at rest under KMS (SaaS) or a self-hostable key-management arrangement; documented rotation and recovery. Never a single unrecoverable value in an env file.
- Every outbound HTTP destination the tenant can influence (webhooks, CRM, knowledge ingestion, media fetch) passes SSRF/DNS-rebinding/redirect validation at configuration time **and** on every delivery.

## 7. Observability

OpenTelemetry traces/metrics/logs with correlation and redaction. Key signals: ingress ACK latency, normalization lag, outbox lag, oldest queue item per tenant, retry/DLQ/`outcome_unknown` counts, tenant fairness, provider errors/quality/quota, DB latency/locks/replication/storage, socket reconnects, media scan failures, CRM lag/conflicts, AI latency/cost/eval scores, audit completeness.

No unbounded metric label cardinality — never message IDs or contact IDs as labels. Alert on symptoms with burn-rate policy and runbook links, not on every transient retry.

## 8. Deployment modes

One source, one schema, one set of API contracts, one release artifact set. `DEPLOYMENT_MODE` is trusted installation configuration validated at boot; it is never selected by a request. See ADR-0002 and `docs/product/business-rules.md` §9–10.

- **SaaS**: platform control plane, tenant provisioning/placement/quotas, HA topology sized to the Target profile.
- **Self-hosted single**: one-time bootstrap, single-host hardened profile for the Pilot profile, plus a documented HA profile using the same Helm charts. No vendor support account and no remote administrative tunnel by default. AI and OpenSearch are **not** required for first login or core messaging.

## 9. Known environment constraints (2026-09-07 workstation)

| Need | Status | Consequence |
|---|---|---|
| Node 22.23.2, pnpm 9.12.0, git, uv | available | — |
| Docker / OrbStack | **absent, daemon not running** | Testcontainers path unavailable locally |
| PostgreSQL | absent as a service; **`embedded-postgres` verified working (PG 17.4, no Docker, no admin rights)** | Local integration + RLS tests proceed via ADR-0015 |
| RabbitMQ | **absent** | Broker-driver contract tests are `blocked_env` until Docker or a remote broker exists — see ADR-0004 |
| k6 | absent | Load gates are `blocked_env`; profiles are still authored |
| Meta assets / Odoo instance | not supplied | All `Live` statuses stay `blocked_no_asset`; simulator work proceeds |

These are recorded, not worked around silently. Nothing in this table permits marking a blocked gate as passed.
