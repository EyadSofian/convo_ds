# ADR-0005 — The webhook ACK means "durably journaled", nothing more

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P2 ingress
- **Requirement IDs:** DEL-01..DEL-06, EVT-01..EVT-03

## Context

Providers retry on non-2xx and eventually give up. An ACK that means "we started thinking about it" loses data on crash; an ACK that waits for CRM/AI/media work blows the latency budget and makes an unrelated dependency able to lose our inbound messages.

## Decision

The ingress does exactly this, in order:

1. TLS termination, body size and content-type limits.
2. Provider authentication: HMAC over the **exact raw request bytes**, constant-time comparison. A `hub.verify_token` used for the GET challenge is **not** authentication for a POST.
3. Resolve connection and tenant from **verified channel assets**. A caller-supplied tenant is never authority.
4. Persist the raw event/batch envelope plus receipt metadata **durably**, then ACK 200. Durable = committed to Postgres (single-host) or committed and replicated per the HA profile. If persistence fails, return a retryable non-2xx. Never 200.

Everything after that — normalization, dedupe, domain change, CRM, media, AI — happens asynchronously. Normalization carries a schema version and provider/type-specific dedupe semantics. A poison or unknown element is quarantined **individually**; the rest of the batch is processed.

Budget: ACK p95 ≤200 ms, p99 ≤1 s.

## Consequences

- The ingress is a small, boring, separately deployable service with a tight dependency set (Postgres only). That is the point.
- Replay is possible from the raw journal, subject to the retention policy in ADR-0012.
- We store some data we will never use. Accepted; retention bounds it.

## Alternatives rejected

- **Queue-first ingestion.** Rejected: makes the broker a hard dependency of not-losing-inbound and complicates the raw-evidence story.
- **Process synchronously then ACK.** Rejected on latency and blast radius.

## How this is verified

- EVT-01: altered byte / missing / wrong signature rejected before any processing.
- EVT-02: duplicate across differently ordered batches → one domain effect, no dropped legitimate receipt.
- EVT-03: multi-entry batch with one unsupported element → all valid events handled, unsupported quarantined with evidence.
- Kill-before-commit test asserts a non-2xx response.
- Latency budget assertion in the integration suite.
