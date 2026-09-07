# CONVO — Execution ledger

This file is the handoff. Any new session or smaller-context agent should read this first, then `docs/requirements/traceability.md`, then the relevant phase card in `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md`.

---

## Last completed task — P1-T1

**Task / phase / requirement IDs:** P1-T1 — workspace foundation and an executable integration harness. TEN-01, TEN-02, TEN-03, TEN-04, TEN-05, IAM-08 (partial), DEP-01, DEP-02 (partial), DEP-14 (gate not yet met), ADR-0003, ADR-0015.

**Source revision and environment:** commit following `adf5462`. macOS 25.6.0 arm64, Node v22.23.2, pnpm 9.12.0. PostgreSQL 17.4 started in-process by `embedded-postgres` — no Docker anywhere in this run.

**Business behavior delivered:** none customer-visible yet. What exists is the tenancy substrate every later feature depends on: two separate database roles, a migration runner with drift detection, transaction-local tenant context, RLS policies, and the permission catalogue.

**Files / migrations / commands:**

| Path | What it is |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.js`, `vitest.{config,workspace}.ts` | Workspace, TypeScript strict (incl. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), lint, test projects |
| `packages/database/migrations/0001_foundation.sql` | installations, tenants, users, permissions, roles, role_permissions, memberships, teams, team_members, membership_scopes — all cross-entity FKs composite on `tenant_id` |
| `packages/database/migrations/0002_rls.sql` | `ENABLE` + `FORCE ROW LEVEL SECURITY` and USING/WITH CHECK policies on all 7 tenant-owned tables; explicit grants to the runtime role |
| `packages/database/migrations/0003_permission_catalogue.sql` | 29 permission keys with a `delegable` flag |
| `packages/database/src/bootstrap.ts` | Cluster bootstrap as superuser: creates `convo_migrator` (owner) and `convo_app` (runtime), explicitly strips SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE from the runtime role |
| `packages/database/src/migrate.ts` | Forward-only migrations, one transaction each, SHA-256 checksum recorded — an edited applied migration fails loudly |
| `packages/database/src/context.ts` | `withTenant()`: `set_config('convo.tenant_id', …, true)` then **reads it back** and fails if the database disagrees |
| `tests/support/{cluster,global-setup,pools}.ts` | Real PostgreSQL per run on a free port; seeds two tenants **through the RLS path**, bypassing no policy |
| `tests/integration/*.test.ts` | 18 assertions across runtime-role privileges, tenant isolation, permission catalogue |
| `.github/workflows/ci.yml` | lint → typecheck → build → integration |

**Checks actually run, exit codes and evidence:**

| Command | Exit | Result |
|---|---|---|
| `pnpm lint` | **0** | clean |
| `pnpm typecheck` | **0** | `tsc -b` + tests project, strict |
| `pnpm build` | **0** | |
| `pnpm test:integration` | **0** | **3 files, 18 tests passed**; 3 migrations applied to PostgreSQL 17.4 |
| `vitest run --coverage --project integration` | **1** | **coverage gate FAILING — see below** |

What the 18 tests actually prove, rather than assert about themselves:

- The runtime role has `rolsuper=false`, `rolbypassrls=false`, `rolcreatedb=false`, `rolcreaterole=false`, **owns zero tables**, cannot `CREATE TABLE`, and cannot `ALTER ROLE … BYPASSRLS`.
- All 7 tenant-owned tables have `relrowsecurity` **and** `relforcerowsecurity` true.
- With **no** tenant context, `SELECT` on tenants/memberships/roles returns **0 rows** — default deny, not a filter someone remembered to write.
- Tenant A cannot see tenant B's rows **even when given B's exact ids** (tenant, membership, role all return 0).
- Inserting or updating a row into another tenant is rejected by the RLS `WITH CHECK`; deleting another tenant's membership by id affects 0 rows and the row is still there afterwards.
- Tenant context **does not survive a pooled connection release**: after the transaction, `app_current_tenant()` is NULL and the same physical connection sees 0 tenants.
- A membership in tenant A referencing a role in tenant B is rejected by the composite foreign key — the cross-tenant relationship is unrepresentable, not merely unfiltered.
- One global identity can hold memberships in two tenants (the SaaS case still works).
- `withTenant("' OR 1=1 --")` is refused before it reaches SQL.

**Coverage/exclusions and observed failures:** the coverage gate (DEP-14) is **`failing`, and is reported as failing**: 14.51% lines, 28.57% functions, 53.33% branches, against thresholds of 100/100/95. Two real causes: `cli.ts` has no test at all, and `bootstrap.ts`/`migrate.ts` run inside Vitest's global-setup process, which the v8 provider does not instrument — so the number understates actual execution but is still the measured artifact. **The thresholds were not lowered and no exclusion was added.** Closing this is P1-T2.

**Provider-live verification:** none. Unchanged from P0.

**Deployment-mode verification:** none. `DEPLOYMENT_MODE` exists as a column and a check constraint; the boot-time configuration validation that makes MODE-01 true is P1-T3.

---

### Previously

**P0 (commit `adf5462`)** — requirement registry (~230 rows, 23 families), business rules, capacity hypotheses, architecture, 16 ADRs, data model, ~190-operation API inventory, design tokens with per-value provenance, test strategy, threat model, provider evidence ledger. Verified in that pass: `embedded-postgres` runs a real PostgreSQL 17.4 without Docker or admin rights; the Figma Community page returned **HTTP 403** to `WebFetch` and the Figma connector is unauthenticated.

---

## Open dependencies

These block **only** the rows named. Everything else proceeds.

| # | Needed input | Blocks | Independent work that continues |
|---|---|---|---|
| 1 | Meta app + WABA + test phone number + authorized test recipient | CH-WA-01/03/06/07, CMP-05, live smoke tests | Adapter, simulator, fixtures, policy engine, full inbox UI |
| 2 | Facebook Page + Instagram professional account + granted scopes | CH-MSG-*, CH-IG-*, CH-06 | Same as above per channel |
| 3 | Odoo instance + version + service account | CRM-01..CRM-06, CRM-11 | Adapter, mapping engine, conflict UI, fixtures |
| 4 | Docker/OrbStack **or** a reachable RabbitMQ + S3-compatible endpoint | Broker/object-store contract tests (`blocked_env`) | Postgres dev driver + filesystem adapter under ADR-0004/0015 |
| 5 | Staging infrastructure + k6 | DEP-10, all capacity SLOs | Load profiles and thresholds are authored now |
| 6 | Figma access (authorize the connector, or drop an exported reference image into `docs/design/reference/`) | UX-01 upgrade from `estimated` to `measured` | Whole design system builds on labelled estimates |
| 7 | Hosting region + domain + TLS + production authorization | DEP-03/05/07/09, MODE-13..17 | Images, Helm charts, Compose profiles, installer, runbooks |
| 8 | OIDC identity provider | IAM-22 | Local auth, MFA, sessions, invitations |

**Nothing above justifies skipping implementation or tests.** Independent work is the default; these are recorded so a blocked live gate is never quietly reported as passed.

---

## Next task — P1-T2

**Task:** close the coverage gate on the database package, then add installation bootstrap and deployment-mode validation.

**Requirement IDs:** DEP-14, MODE-01, MODE-02, MODE-03, MODE-04, DEP-02.

**Scope:**
1. Unit tests for `migrate.ts` (fresh apply, re-apply is a no-op, **checksum drift is rejected**, a failing migration rolls back and records nothing) and for `bootstrap.ts` (idempotent re-run, unsafe identifier rejected, runtime role attributes stripped even if pre-created with wider rights) — run **in-process** so they are instrumented.
2. Unit tests for `cli.ts` argument and environment validation.
3. Boot-time configuration schema: `DEPLOYMENT_MODE` validated at startup, invalid value fails to boot, and it is readable from **nothing but** validated environment.
4. `GET /instance` shape defined in the contract package (sanitized capabilities only).
5. One-time bootstrap: creates exactly one company and Owner, then disables itself; a second call is a harmless typed rejection; `self_hosted_single` refuses a second company by every path.

**Exit checks:**
```
pnpm lint && pnpm typecheck && pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:coverage      # must reach the stated thresholds, not have them lowered
```

**Entry condition:** met.
