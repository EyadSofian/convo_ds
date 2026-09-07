# CONVO — Test strategy and harness plan

Governed by MASTER-PROMPT §13 and ADR-0015. Coverage is a **gate**, not a proof of correctness.

## 1. Gates

| Gate | Target | Note |
|---|---|---|
| Line coverage, first-party executable source | **100%** | Excludes only generated/vendor code, type declarations, provably unreachable code — each exclusion listed with a reason |
| Function coverage, first-party | **100%** | Same exclusion rule |
| Branch coverage, critical modules | **100%** | tenancy/authz, consent/window policy, idempotency/outbox, delivery outcome classification, campaign eligibility/budget/scheduler, handoff ownership |
| Branch coverage overall | **≥95%** | |
| Mutation score, critical modules | **≥90%** proposed | Surviving mutants investigated; equivalents justified in writing |

Forbidden: lowering thresholds, skipping failing suites, blanket exclusions, deleting tests, or writing trivial functions to inflate a number. If a target is missed, report the gap and keep improving it — never claim 100% without a coverage artifact.

CSS and design assets are covered by component, visual and accessibility checks, not by meaningless executable coverage.

## 2. Test layers

1. **Unit — business invariants.** Boundaries, invalid input, state transitions. Not assertions that restate the implementation.
2. **Property-based.** Idempotency; event ordering and folding; eligibility; pagination; budget conservation. Arbitrary duplication and reordering must converge to the same projection.
3. **Mutation.** Critical modules only, targeted at changed code.
4. **Integration against real services.** Real Postgres with real migrations and the real non-superuser runtime role. Only the external provider boundary is mocked.
5. **Contract.** Consumer/provider schema contracts and versioned fixtures per Meta event/message/capability, per Odoo version, per public API operation. OpenAPI drift and breaking-change checks.
6. **E2E.** Playwright, real backend, real DB, seeded tenants and roles.
7. **Accessibility.** axe + keyboard-only journeys + 200% zoom + RTL/LTR.
8. **Security.** SAST, dependency and secret scanning; dynamic API tests; SSRF/XSS/CSRF/IDOR/mass-assignment/resource-exhaustion suites.
9. **Fault and concurrency.** Injected failures at transaction and network boundaries; chaos only on disposable or explicitly authorized staging.
10. **Load.** k6 open-model with thresholds; offered vs achieved rate, dropped iterations, error and latency histograms, post-test integrity reconciliation.
11. **AI evals.** Golden set with per-language slices (P7).

## 3. Environment matrix (ADR-0015)

| Dependency | Local, no Docker | CI | Valid for production claims |
|---|---|---|---|
| PostgreSQL | `embedded-postgres` — **verified working: PG 17.4, no daemon, no admin rights** | service container / Testcontainers | both |
| Broker | `postgres` dev driver | RabbitMQ service container | **RabbitMQ only** |
| Object storage | filesystem adapter | MinIO | S3-compatible only |
| Provider | labelled simulator | labelled simulator | **never** — live needs authorized assets |
| k6 load | unavailable → `blocked_env` | staging with k6 | staging only |

Every test artifact records: source revision, environment and resources, seed, input distribution, exact commands, tool versions, timestamp — **and which substitute it used**. A test that passed on a substitute never upgrades a `blocked_env` row to `passed`.

## 4. The behavioural matrix

The 40+ scenarios in MASTER-PROMPT §13 (SEC/EVT/TX/SEND/CMP/OWN/CRM/ID/UI/OPS/DR/AI) are tracked one-to-one in `docs/requirements/traceability.md` under the SEC family. They are **release gates**, not a nice-to-have suite. Each gets a named test file and a recorded run.

## 5. Commands

```
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:coverage
pnpm test:property
pnpm test:mutation
pnpm test:integration
pnpm test:contracts
pnpm test:e2e
pnpm test:a11y
pnpm test:security
pnpm test:load:target      # refuses to run against production
pnpm test:recovery         # refuses to run against production
uv run pytest              # services/ai
uv run convo-ai-eval       # golden set
```

`test:load:*` and `test:recovery` must fail fast if pointed at a production target (DEP-11).

## 6. CI ordering

format/lint/types/schema/contracts → unit/property/coverage → integration/concurrency → build/E2E/accessibility → security. Mutation runs targeted at critical changes. Longer mixed load, soak and recovery runs are **release gates on suitable staging** — never faked locally.

Fix failures and rerun the affected checks. Do not repeatedly run expensive unrelated clean suites without a change or an unresolved concern.

## 7. Fixtures and seed data

- Two seeded tenants minimum, always, so every list/search/export/socket test can assert isolation.
- One seeded user per built-in role, with an allow **and** a deny case each.
- Realistic Arabic/English content: long names, mixed script, phone numbers, order IDs, emoji, ZWJ sequences, missing avatars, 10k-message threads, empty inboxes.
- Deterministic seeds; realistic persisted volume — not a tiny warm-cache fixture.
- Provider fixtures recorded per Graph version, including batched webhooks, duplicates, reordered receipts and unsupported elements.

## 8. What a passing suite does not prove

It does not prove delivery through Meta, RLS in production, HA behaviour, throughput, or that a backup restores. Those need live provider checks, a real HA topology, a measured load run and an actual restore drill — recorded separately in `docs/evidence/`.
