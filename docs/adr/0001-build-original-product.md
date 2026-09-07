# ADR-0001 — Build an original product rather than extend Chatwoot

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks all of P1
- **Requirement IDs:** all

## Context

Chatwoot at pinned commit `c9f1867369ea87580adac3df9f2058bc63da1ef2` is cached read-only under `.research-cache/chatwoot` as *evidence*. It solves a similar domain (accounts, inboxes, conversations, messages, campaigns, policies) and is a genuinely useful reference for domain boundaries and operational lessons.

Three things make extending it the wrong base for this product:

1. **Licence boundary.** The repository root and `enterprise/` carry *different* licences. Several capabilities we need (granular custom roles, some campaign/AI features) live behind plan/enterprise boundaries. Copying from `enterprise/` on the assumption that the whole repo is MIT is a licence violation, not a shortcut.
2. **Stack and team capability.** Chatwoot is Rails + Sidekiq + ActionCable. Our required contracts — transactional outbox with broker confirms, `outcome_unknown` reconciliation, fenced per-conversation dispatch, revision-bound campaign executions, RLS-backed tenancy — are cheaper to build correctly in a TypeScript/Postgres stack the team can maintain than to retrofit into an existing Rails codebase whose invariants differ from ours.
3. **`main` is not a release.** Building a product on an unpinned upstream branch makes our own release evidence unreproducible.

## Decision

Build an original greenfield implementation. Use Chatwoot **only** as read-only domain and operational reference, cited by file and commit. Copy no source. Keep `.research-cache/` git-ignored and clearly labelled as not part of this product.

## Consequences

- We own every line, including the boring parts (auth, invitations, imports). Cost is real and is reflected in the phase plan.
- No upstream security patches arrive for free; our own dependency scanning and SBOM (DEP-13) carry that load.
- Domain lessons still transfer: the inbox/contact-inbox/conversation shape, the policy-object pattern, and the campaign-service validation ordering are all worth learning from.

## Alternatives rejected

- **Fork Chatwoot.** Rejected on licence boundary + stack + retrofit cost, and it would silently replace the agreed architecture.
- **Wrap Chatwoot behind our API.** Rejected: our delivery/ownership/campaign semantics are stricter than what a wrapper can enforce; the wrapper would lie about guarantees it cannot make.

## How this is verified

- No file in `apps/` or `packages/` derives from `.research-cache/`; enforced by review plus a CI check that `.research-cache` is not importable.
- Licence and SBOM report at release (DEP-13).
