# CONVO — Execution ledger

This file is the handoff. Any new session or smaller-context agent should read this first, then `docs/requirements/traceability.md`, then the relevant phase card in `research/convo-2026-09-07/implementation-v2/PHASE-PROMPTS.md`.

---

## Last completed task

**Task / phase / requirement IDs:** P0 — repository audit, business contracts, architecture decisions and design discovery. Touches every requirement family (registry baseline).

**Source revision and environment:** first commit of this repository. macOS 25.6.0 (darwin, arm64). Node v22.23.2, pnpm 9.12.0, npm 10.9.8, git 2.50.1, uv 0.11.26, python3 3.9.6 (system). **Docker: absent, daemon not running. Homebrew: absent. PostgreSQL as a service: absent. k6: absent.**

**Business behavior delivered:** none — P0 produces contracts, not runnable product. No application code exists yet. This is stated plainly rather than implied by document volume.

**Files produced:**

| File | Contents |
|---|---|
| `docs/requirements/traceability.md` | ~230 requirement rows across 23 families, each with four independent status fields; P9 extension registry preserved |
| `docs/product/business-rules.md` | Vocabulary, 9 actor journeys, 14 global invariants, conversation and campaign lifecycles, consent rules, role/scope matrix, channel policy, entitlements, DR business rule |
| `docs/product/capacity-hypotheses.md` | Pilot/Target/Growth profiles, SLO gates, reproducible arithmetic, storage estimates — all labelled hypotheses |
| `docs/architecture.md` | Process roles, repo layout, durability boundaries, failure semantics, security architecture, observability, environment constraints |
| `docs/adr/0001–0016` | 16 accepted ADRs, each with context, decision, consequences, rejected alternatives and verification method |
| `docs/database/erd.md` | ~60 tables with composite-FK and unique-constraint design, indexing and partitioning notes, migration policy |
| `docs/api/operation-inventory.md` | ~190 operations with operationIds, permissions and phases; envelope, error and idempotency conventions |
| `docs/design/design-reference.md` | Access status, observed structure, layout contract, tokens with per-value provenance, bidi rules, state contract, 17-screen inventory |
| `docs/testing/strategy.md` | Coverage gates, 11 test layers, environment substitution matrix, commands, CI ordering, fixtures |
| `docs/security/threat-model.md` | STRIDE over 8 trust boundaries, mitigation→requirement mapping, explicitly accepted limitations |
| `docs/research/provider-evidence.md` | Per-source observation/date/decision ledger for WhatsApp, Instagram, Messenger, Odoo, engineering references, competitors |

**Checks actually run, exit codes and evidence:**

| Check | Command | Result |
|---|---|---|
| Toolchain inventory | `command -v` sweep | exit 0 — recorded above |
| Docker availability | `docker info` | **not found / daemon not running** |
| Real Postgres without Docker | `npm i embedded-postgres@17.4.0-beta.15 && node probe.mjs` | **exit 0 — `PG_OK PostgreSQL 17.4` started, connected, queried, shut down cleanly** |
| Figma reference retrieval | `WebFetch` of the Community file page | **HTTP 403 Forbidden — no content** |
| Figma MCP connector | connector status | **unauthenticated; OAuth impossible in a non-interactive session** |

**Coverage/exclusions and observed failures:** no code, therefore no coverage. Every row in the registry is `Impl=planned`, `Test=not_run`. Nothing is marked passed.

**Provider-live verification:** none, and none attempted. No Meta app, WABA, phone number, Page, Instagram professional account or Odoo instance has been supplied. All `Live` statuses are `blocked_no_asset` or `n/a`.

**Deployment-mode verification:** none. Nothing is deployed anywhere.

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

## Next task — P1-T1

**Task:** workspace foundation and a real, executable test harness.

**Requirement IDs:** DEP-01, DEP-02, DEP-13, DEP-14, TEN-03, TEN-04, TEN-05, MODE-01, ADR-0015.

**Scope:**
1. pnpm workspace, TypeScript strict base config, shared lint/format, pinned Node 22, package scripts matching `docs/testing/strategy.md` §5.
2. `packages/database`: migration runner, the first migration (installations, tenants, users, memberships, roles, permissions), RLS policies, and the separate migration/runtime roles.
3. Test harness on `embedded-postgres`: start → migrate → seed two tenants → run → stop, with per-worker isolation.
4. First real assertions, not placeholders: `pg_roles` shows the runtime role has no superuser/BYPASSRLS and owns nothing; a cross-tenant read and a cross-tenant write are both denied by RLS; tenant context does not leak across pooled transactions.
5. CI workflow: lint → typecheck → build → unit → integration, with a Postgres service container.

**Entry condition:** met (P0 documents committed).

**Exit checks — to be recorded with real exit codes:**
```
pnpm lint && pnpm typecheck && pnpm build
pnpm test:integration   # must include the RLS denial suite
```
Exit criteria: those commands run and pass; the registry rows above move to `Impl=implemented`, `Test=passed`, with evidence paths filled in. If any check fails, it is recorded as `failing` and fixed — never skipped.
