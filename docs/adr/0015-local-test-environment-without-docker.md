# ADR-0015 — Local integration testing without Docker: `embedded-postgres`

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P1 test harness
- **Requirement IDs:** DEP-14, TEN-03..TEN-05, and every integration test

## Context

The master requires integration tests against **real** disposable Postgres/broker/object-store services with migrations and runtime RLS roles — mocking only the external provider boundary. The development workstation (checked 2026-09-07) has **no Docker daemon, no Homebrew, no local PostgreSQL and no k6**. Installing Docker Desktop needs an interactive GUI install and admin rights that this session does not have.

Refusing to test until Docker exists would stall independent work for an environment reason, which the assignment explicitly forbids.

## Decision

**Local/dev/test Postgres comes from `embedded-postgres`**, which downloads a real PostgreSQL binary into the project and runs it as a child process — no daemon, no admin rights. Verified on this machine: **PostgreSQL 17.4 started, accepted a connection, answered `select version()`, and shut down cleanly.**

This is a *real* PostgreSQL, so it exercises migrations, constraints, composite FKs, `SET LOCAL` tenant context and **RLS with a genuine non-superuser runtime role** — the properties we actually need to verify.

**Test-service policy by dependency:**

| Dependency | Local (no Docker) | CI | Production claim source |
|---|---|---|---|
| PostgreSQL | `embedded-postgres` | service container / Testcontainers | either — same engine, same migrations |
| Broker | `postgres` dev driver (ADR-0004) | RabbitMQ service container | **RabbitMQ only** |
| Object storage | filesystem-backed adapter | MinIO service container | S3-compatible only |
| k6 load | unavailable → `blocked_env` | staging with k6 | staging only |

**Honesty rules.** A test that passed only on the local substitute is recorded with the substitute named in its evidence. Broker- and object-store-specific behaviour (publisher confirms under node loss, quorum failover, S3 versioning) stays `blocked_env` in the registry until a real service is available. The dev substitutes never upgrade a `blocked_env` row to `passed`.

## Consequences

- The shipped `postgres` binary is a **universal Mach-O** containing both `x86_64` and `arm64` slices. `select version()` reports `x86_64-apple-darwin23.6.0` because that is the compile-time triple, so the version string alone does not tell us which slice executes. Either way this is a correctness harness, **not** a performance measurement.
- The pinned `embedded-postgres` version is a beta tag; it is pinned exactly and re-evaluated if it misbehaves.
- CI still uses standard service containers, so we are not betting the pipeline on this package.

## Alternatives rejected

- **Wait for Docker.** Rejected: stalls all independent work.
- **SQLite or an in-memory fake for tests.** Rejected outright: no RLS, no composite-FK semantics, no `SET LOCAL` — it would test nothing that matters here.
- **A shared remote dev database.** Rejected: not disposable, not parallel-safe, and it leaks state between runs.

## How this is verified

- Harness smoke test: start → migrate → assert `pg_roles` (runtime role has no superuser/BYPASSRLS) → run the cross-tenant RLS denial suite → stop.
- **Executed 2026-09-07:** `pnpm test:integration` → exit 0, 3 files / 18 tests passed against PostgreSQL 17.4, 3 migrations applied. See `docs/execution/current-task.md`.
- Every test artifact records which substitute it used, alongside the source revision and seed.
