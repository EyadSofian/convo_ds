# ADR-0003 — Tenant isolation: composite keys + RLS + placement abstraction

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P1 schema work
- **Requirement IDs:** TEN-01..TEN-12, SEC-01

## Context

"Add `WHERE tenant_id = ?` everywhere" fails the first time someone writes a background job, an export, a search query or a raw admin script. We need isolation that survives a developer forgetting.

## Decision

Four layers, all required:

1. **Structural.** Non-null `tenant_id` on every tenant-owned table. Every cross-entity FK is composite: `(tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)`. A cross-tenant relationship becomes physically unrepresentable.
2. **RLS.** Enabled with both `USING` and `WITH CHECK`, `FORCE ROW LEVEL SECURITY` where the owner also writes. Runtime role is a plain `LOGIN` role — not the table owner, not superuser, not `BYPASSRLS`. Migrations run as a separate role.
3. **Context.** Tenant context is set **transaction-locally** (`SET LOCAL`) after verifying the actor's membership, and is asserted before the first statement. Pool checkout never inherits a previous transaction's context. A helper enforces "no query outside a tenant transaction" for tenant-scoped repositories.
4. **Application authorization.** RLS is defence in depth. Object/action permissions (`packages/authz`) still run first and are the layer that produces correct 403/404 semantics.

Isolation is extended by explicit design to cache keys, socket topics, object-storage prefixes, search indexes, export artifacts, log/metric detail, backups and AI retrieval.

**Placement** is an abstraction from day one: each tenant row carries a placement descriptor (cell/shard/region). Single-region HA is the default; multi-region writes require a confirmed requirement and its own ADR. This lets a large or regulated tenant move to a dedicated cell without a schema change.

## Consequences

- Composite FKs make some joins wordier and require care in migration ordering. Worth it.
- RLS costs a small planning overhead; measured, not assumed, during P4 load work.
- Some maintenance tooling must run under the migration role and is therefore explicitly audited.

## Alternatives rejected

- **Schema-per-tenant.** Rejected at the Target profile: thousands of schemas make migrations, connection pooling and cross-tenant operational queries painful.
- **Database-per-tenant by default.** Reserved for the placement abstraction (dedicated cell), not the default.
- **Application-only filtering.** Rejected: single point of human failure.

## How this is verified

- `pg_roles` assertion that the runtime role lacks superuser/BYPASSRLS and owns nothing.
- Direct-SQL cross-tenant read/write attempts as the runtime role.
- Pool-reuse leak test across transactions.
- SEC-01 matrix across list, detail, search, export, media, socket and (P7) RAG.
