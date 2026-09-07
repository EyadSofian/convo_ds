# ADR-0008 — Ownership versions and the handoff barrier

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** ownership columns land in P2; enforcement completes in P7
- **Requirement IDs:** AI-01..AI-05, OWN-01..OWN-03, CON-07

## Context

The dangerous moment in any AI-assisted inbox: a human takes over while a bot request is already in flight to Meta. Products routinely claim "instant takeover". Nobody can recall a request Meta has already accepted.

## Decision

**Explicit ownership state** per conversation: `bot_active`, `handoff_pending`, `human_active`, `bot_paused`, with a **monotonically increasing `owner_version`** and a full audit trail. Ownership is modelled from P2 even though AI arrives in P7, because retrofitting it later would mean re-touching the entire send path.

**One serialized gate per conversation** orders ownership transitions against external send starts, using the same fencing mechanism as ADR-0006.

**Rules:**
- A takeover or policy handoff invalidates queued/outdated AI generations and blocks new bot permits at the permit check, not in the UI.
- Every AI result is re-checked against `owner_version` **when submitted** and **again before dispatch**. A stale result is dropped with an auditable reason.
- If a bot send is already in flight or ambiguous, the conversation shows `handoff_pending` with its actual status. Human ownership is confirmed only after the documented barrier drains or reconciles the older work — or, under an explicitly safe operator policy, after communicating an unresolved external outcome.
- The bot resumes **only** by an authorized explicit resume or reassignment. A new inbound message or a timeout never silently resumes it.
- Handoff transfers transcript, summary, intent, tool outcomes and unresolved questions to the agent. A customer asking for a person is honoured; if no agent is available the fallback is explicit, not silent.

**We never claim an atomic undo across Meta.** The UI wording for `handoff_pending` says what is actually true.

## Consequences

- Slightly slower takeover in the rare in-flight case, in exchange for never lying about it.
- Every send-permit check gains an ownership predicate — cheap, and centralized in one place.

## Alternatives rejected

- **Best-effort cancel flag.** Rejected: races, and produces the "we cancelled it" lie.
- **Ownership inferred from presence.** Rejected: presence is ephemeral and must never determine durable ownership.

## How this is verified

- OWN-01: two agents claim at the same version → one winner, one typed conflict.
- OWN-02: AI result returns after takeover → no permit issued, state truthful.
- OWN-03: takeover during an in-flight bot send → documented barrier behaviour, no recall claim.
- Local handoff decision p95 ≤1 s (excluding drainage of an already in-flight request).
