# ADR-0004 — Transactional outbox, RabbitMQ quorum queues, and a dev driver

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P2 delivery work
- **Requirement IDs:** DEL-07..DEL-09, TX-01..TX-03

## Context

Two independent systems (Postgres, a broker) cannot be updated atomically. Any design that writes to the DB and then publishes "and hopes" loses work. Meanwhile this workstation has **no Docker and no RabbitMQ**, so the local story matters too.

## Decision

**Transactional outbox.** Domain change and outbox row commit in one transaction. A relay reads the outbox, publishes a *small envelope* (IDs, not payloads) with publisher confirms, and marks the row **only after the confirm**. A crash between publish and marker legitimately produces a duplicate — therefore **every consumer is idempotent**, keyed on a business key, and consumer ACK happens **after** its own commit.

**Broker.** RabbitMQ quorum queues across failure domains, manual acknowledgement, bounded prefetch, per-role queues, DLQ with bounded retries and an audited replay tool.

**Driver abstraction with an explicit honesty rule.** The transport is behind a port with two drivers:

| Driver | Allowed in | Notes |
|---|---|---|
| `rabbitmq` | production (both modes), staging, CI | The only driver whose behaviour we may describe in release claims |
| `postgres` (`SKIP LOCKED` queue) | local development and unit/integration tests **when no broker is available** | Same port, same idempotency requirements |

The `postgres` driver is a developer convenience, **not** a substitute for broker contract tests. Broker-specific tests (confirm loss, node loss, quorum behaviour, DLQ) stay `blocked_env` in the registry until Docker or a remote broker is available. They are never marked passed by running the dev driver.

## Consequences

- Duplicates are normal and designed for, rather than surprising.
- The dev driver adds a small amount of code but removes "you cannot run anything locally".
- Two drivers means two contract test runs; the `postgres` one is not evidence for the `rabbitmq` one.

## Alternatives rejected

- **Publish inside the transaction / 2PC.** Rejected: fragile, and the broker is not a resource manager we want in a distributed transaction.
- **Postgres-only queue in production.** Rejected: the master mandates RabbitMQ quorum queues, and campaign fan-out at Target profile wants a real broker.
- **Skipping local work until Docker exists.** Rejected: that would stall independent work for an environment reason.

## How this is verified

- TX-01: kill before commit → no success ACK.
- TX-02: commit succeeds, publish/confirm fails → relay recovers, nothing lost.
- TX-03: publish succeeds, marker lost → duplicate delivered, **one** internal effect.
- Property test: consumer idempotency under arbitrary duplication and reordering.
