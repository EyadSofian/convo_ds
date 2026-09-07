# ADR-0007 — Hierarchical fair dispatch with an interactive reservation

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P4 dispatcher
- **Requirement IDs:** CMP-13..CMP-16, DEL-11, CMP-T06

## Context

A one-million-recipient campaign and a customer waiting for a reply compete for the same DB pool, the same worker CPU and the same provider quota. Naive FIFO means the customer waits behind the campaign. Naive per-tenant round-robin wastes capacity when only one tenant is active.

## Decision

**Separate pools, shared limiter.** Inbound processing, interactive outbound and bulk outbound run in *different worker pools* with independent concurrency, but share one provider rate limiter per connection/portfolio so we never exceed the provider's actual limits by adding workers.

**Three-level scheduling:** tenant → connection/phone → traffic class.

**Interactive reservation** starts at a configurable **20%** hypothesis of each connection's permitted throughput, with **borrowing**: bulk may use the reserved share while no interactive work is queued, and must yield it within a bounded window when interactive work arrives. The 20% figure is a starting hypothesis to be *measured* in P4, not a hard-coded law; fairness is validated by the CMP-T06 scenario (one tenant offering most of the traffic) rather than by asserting equal slices.

**Bounded everything.** Cursor-based batching, bulk inserts, bounded in-memory buffers, bounded prefetch, explicit `max_in_flight`. The recipient/attempt ledger lives in Postgres; queue messages carry small references. Row claims with leases and unique business keys prevent duplicate work across restarts.

**Conservative under uncertainty.** Redis counters may accelerate coordination, but if quota/budget state is unavailable the dispatcher **pauses or slows** rather than failing open. Budget and consent are never fail-open.

**Circuit breakers** per template and per channel stop poison sources; `Retry-After` is honoured; backoff is exponential with jitter and capped by attempts and wall time.

## Consequences

- More configuration surface (per-pool concurrency, reservation, ceilings). Documented in the ops runbook.
- Fairness must be *measured*; until P4 load evidence exists, fairness claims stay `blocked_env`.
- Per-tenant queue-age and saturation metrics are required, not optional.

## Alternatives rejected

- **Single queue, FIFO.** Rejected: interactive starvation.
- **Strict equal per-tenant slices.** Rejected: wastes capacity and does not reflect real workloads.
- **Scale workers to solve throughput.** Rejected as a myth: provider limits and DB pool are the ceilings.

## How this is verified

- CMP-T06 with one dominant tenant: other tenants and interactive p95 hold configured fairness.
- Memory profile flat across a 1M-recipient snapshot (CMP-01).
- Reservation conservation property test.
- Restart mid-dispatch: no duplicate work, no lost claims.
