# ADR-0013 — AI authority is bounded by server-side policy, not by the prompt

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P7
- **Requirement IDs:** AI-06..AI-15, TEN-11, AI-T01..AI-T02

## Context

Prompt injection *will* reach the model — it arrives inside customer messages and inside ingested knowledge. Any design where the model's output determines its own authority is broken by construction.

## Decision

**Tools are scoped service users of our own APIs.** Tenant identity, actor and policy context are supplied by **server code**; no tool argument can change them. Read tools return only objects the caller is permitted to see. Side-effect tools require deterministic authorization, idempotency keys, and an approval bound to exact arguments, revision and expiry.

**Forbidden by design:** raw DB credentials, arbitrary SQL, unbounded web fetching, unrestricted code execution.

**Retrieval.** Tenant and source ACL filters are applied **before** content reaches the model, not by asking the model to be careful. Arabic originals are preserved; normalization applies only to search representations. Retrieval combines a lexical Arabic-analyzer leg with dense retrieval (pgvector first), fused and reranked. User-specific CRM facts come from scoped tools at request time — they are never cached as generic knowledge. A deleted or revoked source disappears from retrieval and derived caches within a documented bound.

**Rollout order.** Suggestions, summaries and classification first, human approval by default. Autonomous responding is enabled per intent only after that intent passes its eval gate.

**Budgets and fallback.** Hard caps on turns, tokens, wall time, tool calls, concurrent runs and per-tenant spend. Latency targets: p95 AI draft ≤8 s on the golden workload, hard request budget 15 s. Any timeout, provider failure or cost ceiling produces a **visible human fallback**; it never blocks message ingestion or a human reply. The emergency stop works while the AI service is down.

**Evaluation.** A reproducible golden set (proposed 300 cases: 100 Egyptian/MSA, 60 Gulf, 60 English, 40 mixed, 40 adversarial — to be re-weighted to the real audience) tracks answer/task success, unsupported claims, source relevance, correct tool + arguments, correct handoff, privacy leakage and per-language slices. The safety suite requires **zero observed** forbidden tool calls or cross-tenant disclosures — reported as tested evidence, never as proof against all possible inputs. Model self-confidence and uncalibrated LLM judges are not ground truth.

Provider and model versions and prompts are pinned and versioned. There is no global cross-tenant memory.

## Consequences

- Tool development is slower because each tool needs an authorization story and tests.
- Some desirable autonomy ships late. Correct: it ships after its eval gate.

## Alternatives rejected

- **System-prompt guardrails as the isolation mechanism.** Rejected: not an access control.
- **A single "AI can read the tenant" credential.** Rejected: no scope, no audit, no least privilege.
- **Self-hosted model serving assumed cheaper.** Not assumed. The provider abstraction *permits* it; GPUs are not required for the core inbox, and any cost claim needs measurement.

## How this is verified

- AI-T01: injection attempting a cross-tenant read or a tool write → no data, no effect.
- AI-T02: LLM timeout / cost ceiling → visible human fallback, inbox unaffected.
- Expired approval fails; stale-ownership result gets no permit (ADR-0008).
- Recorded eval scores and costs per release — actual numbers, or `not_run`.
