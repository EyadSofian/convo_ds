# ADR-0011 — OpenAPI is the contract source; `/api/v1` with additive evolution

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P1 API infrastructure
- **Requirement IDs:** API-01..API-17

## Context

Three consumers share one surface: our own SPA, the public API, and (later) AI tools. If they drift, the UI silently becomes a privileged client with undocumented endpoints — which is exactly how authorization holes appear.

## Decision

**One versioned REST surface, `/api/v1`.** The first-party UI uses the *same* endpoints and the *same* domain services as the public API. No undocumented helper routes: CI diffs registered routes against the spec and fails on either direction.

**OpenAPI is the source of truth.** Types and the client are generated from it; runtime validation artifacts are generated where practical (shared TypeScript types alone perform no runtime validation). Spec lint, example validation and a backwards-compatibility check run in CI.

**Evolution policy.** Within `v1`: additive only — new optional fields, new endpoints, new enum values behind capability flags. Breaking changes require `/api/v2` running alongside, a documented deprecation window and a migration note. Response shapes are closed for clients that must not break; new required request fields are breaking.

**Non-negotiable conventions.**
- Cursor pagination with a stable tie-breaker, max page sizes, bounded filters, documented sort, opaque tamper-resistant cursors bound to tenant+filter+sort, typed expiry error with a safe refresh path.
- Canonical envelopes: `{ data, page, request_id }` and `{ error: { code, message, request_id, details } }` with stable machine codes; user-visible text is localized client-side from the code.
- `Idempotency-Key` on mutating retryable commands, scoped by tenant+principal+operation, storing a normalized request hash and the durable result; same key+body → same result, same key+different body → conflict; concurrent and crash cases handled atomically; retention covers the operation lifetime (a long-running campaign must stay protected).
- `If-Match`/version preconditions on contested updates.
- 202 for accepted async work, 201 for synchronous creation, typed 4xx, 429 with guidance. **Never HTTP 200 wrapping a hidden error.**
- Unknown-to-caller protected resources return the same 404 shape as nonexistent IDs; unauthenticated → 401; permitted-resource action denial → 403.
- State-changing endpoints never use GET. Tokens in callback paths are redacted from access logs.

## Consequences

- Spec-first adds friction to every endpoint. That friction is the control.
- Generated clients mean UI compile errors when the contract changes — the desired failure mode.

## Alternatives rejected

- **Code-first with generated docs.** Rejected: docs drift, and the UI grows private endpoints.
- **GraphQL.** Not required; would add its own authorization and cost-control surface for no stated benefit here.
- **Unversioned "internal" API for the SPA.** Rejected explicitly: this is the pattern that creates privileged undocumented routes.

## How this is verified

- Route-vs-spec drift test; breaking-change check against the previous published spec.
- Idempotency tests: concurrent same key, different body, crash mid-flight, long-lived retention.
- Status-code and error-envelope contract tests, including the 404-vs-403 disclosure rule.
- Documented curl examples executed against a real local backend (API-17).
