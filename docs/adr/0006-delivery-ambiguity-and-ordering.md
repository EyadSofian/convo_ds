# ADR-0006 — `outcome_unknown` is a first-class outcome; ordering is per-conversation

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P2 send path
- **Requirement IDs:** DEL-12..DEL-18, SEND-01..SEND-04

## Context

Between "we sent an HTTP request to Meta" and "we stored Meta's answer" there is a window where a timeout, a connection reset or our own crash leaves us genuinely unable to know whether a message was sent. The industry default — retry on timeout — sends duplicate messages to real customers.

## Decision

**Three-valued outcome.** Every adapter `send()` returns exactly one of `accepted` | `definitely_rejected` | `outcome_unknown`. The classifier is explicit and unit-tested per provider; it is not "did an exception occur".

**Durable attempt before the network.** A permit/attempt row commits *before* the outbound request. After a crash, recovery finds the attempt, sees no recorded response, and marks it `outcome_unknown` — it does **not** re-send.

**Never blindly retry unknown.** An `outcome_unknown` attempt may be resolved only by:
1. a provider idempotency contract the adapter has actually verified, or
2. a reliable provider lookup/correlation path, or
3. a human decision recorded as a controlled manual retry.

Absent all three, the uncertainty stays visible in the UI, the recipient stays ineligible for automatic retry, and any reserved budget stays held.

**State separation.** Command state (`queued, dispatching, provider_accepted, rejected, retry_scheduled, skipped, cancelled, failed, outcome_unknown`) and provider delivery state (`sent, delivered, read`) live in different columns and fold independently. There is no `max(status_int)`. Provider timestamps and our observation timestamps are both stored.

**Receipt anomalies are evidence, not bugs to smooth over.** A `read` arriving before `delivered` leaves the timeline at `read`. A `failed` arriving after a confirmed `delivered` is recorded as an anomaly and does not erase the delivery. A receipt arriving before the send response is held and reconciled, never dropped.

**Ordering.** Per-conversation ordering only, via a serialized dispatch gate carrying a fencing token and a durable ownership/dispatch version. Locks have bounded lifetimes and recovery. A stale worker's write is rejected by the fence. We do not claim global ordering across providers.

## Consequences

- The UI must show a state most products hide. That is a feature: it is the truth.
- Campaign completion counts must carry `outcome_unknown` separately, forever.
- Reconciliation logic is per-provider and may simply be "unsupported" for some cases.

## Alternatives rejected

- **Retry on timeout.** Rejected: duplicates to customers, plus double billing.
- **Assume failure on timeout.** Rejected: same duplicate risk on the next attempt, plus a false "failed" in reporting.
- **Client-generated provider idempotency keys everywhere.** Rejected as a blanket assumption: only used where the provider's contract is verified.

## How this is verified

- SEND-03 fault injection: provider accepts, response lost → `outcome_unknown`, zero resends.
- SEND-01/02 idempotency-key tests, concurrent and after crash.
- SEND-04: window closes / identity rotates while queued → revalidate and skip safely.
- EVT-04 receipt anomaly tests, each run twice to prove no double counting.
- Property test: arbitrary receipt permutations fold to the same final projection.
