# ADR-0009 — Pinned Graph versions and a versioned capability matrix per channel

- **Status:** accepted
- **Date:** 2026-09-07
- **Phase gate:** blocks P2 (WhatsApp) and P3 (Messenger, Instagram)
- **Requirement IDs:** CH-00..CH-06, CH-WA-*, CH-MSG-*, CH-IG-*

## Context

The three Meta channels are separate products with separate hosts, tokens, scopes, windows and capabilities. Treating them as "Meta messaging" produces exactly the bugs that get an app rejected: an Instagram token sent to `graph.facebook.com`, a WhatsApp template offered on Messenger, a character limit applied to Arabic bytes.

The v2 research (7 Sep 2026) directly read Meta's Instagram messaging page; several other Meta pages returned HTTP 429 to text fetches. The Graph version seen in one example (v26.0) is an *observation from one page*, not proof of the current supported version for every product.

## Decision

**Pin per adapter, per environment.** Each adapter declares its own `graph_version` (and host: `graph.facebook.com` vs `graph.instagram.com`) in configuration, defaulting to a pinned value recorded in `docs/research/provider-evidence.md` with its source URL and observation date. Bumping a version is a config change plus a fixture re-record plus a capability-matrix diff — never an implicit follow-the-latest.

**A versioned capability matrix per channel** declares, for a given version: supported inbound event types, supported outbound message types, window rules, initiation rules, template support, receipt support, attachment types and text limits **in both characters and UTF-8 bytes**. Adapters expose it through `capabilities()`; the UI reads it to enable/disable/explain options.

**Nothing is inherited across channels.** Separate scopes, separate token types, separate fixtures, separate contract tests. Instagram Login and Facebook Login are two *separate* adapter configurations with separate evidence.

**Unsupported ≠ false.** An unsupported receipt renders `not_available`, never `false` or `0%`. Unsupported inbound payloads are stored intact and shown as a documented fallback rather than dropped.

**Optimistic features are flagged off.** Direct Send, coexistence, history sync and echo-heavy behaviours default to disabled and may only be enabled after account/region/version-specific evidence is recorded.

## Consequences

- Three adapters with three fixture sets and three capability matrices — more work, correct behaviour.
- Version bumps have a visible cost, which is what forces us to actually re-verify.

## Alternatives rejected

- **A single "Meta" adapter with flags.** Rejected: the flags always leak the wrong default across channels.
- **Follow the latest Graph version automatically.** Rejected: silent breaking changes with no fixture evidence.

## How this is verified

- Contract tests per adapter per supported message/event type, against recorded fixtures.
- A capability snapshot test that fails when a version bump changes the matrix without a documented decision.
- Arabic byte/character boundary tests (CH-IG-04) on every text-bearing channel.
- `Live` status stays `blocked_no_asset` until an authorized test asset produces a real inbound + reply + receipt.
