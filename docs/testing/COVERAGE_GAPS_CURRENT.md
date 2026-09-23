# Current Coverage Gap Register

Generated from the fresh `coverage/coverage-final.json` after `pnpm test:coverage` on 2026-09-23. This replaces all earlier snapshots. The full coverage command passed its unchanged 100% gate: 225 instrumented files, 29,813/29,813 statements, 29,813/29,813 lines, 2,212/2,212 functions, and 11,789/11,789 branch outcomes.

## Uncovered items

None. The fresh coverage JSON contains no uncovered statements, functions, or branch outcomes.

## Last resolved gaps

- Added direct OutboundService tests for conflicting idempotency ownership and rejecting a WhatsApp catalogue template on a non-WhatsApp connection.
- Added ConversationService service-window tests for non-applicable channels, no inbound, invalid timestamps, and exact expiry boundary.
- Added an Inbox action test for refreshing while conversation state is loading.
- The template preview fallback branches were removed where the underlying RegExp iterator guarantees an index and captured token; the label branch now also covers a body variable example.
- Removed the unused auth lockup class parameter and its unreachable conditional.
- Passed the conversation's authoritative connection ID into the template action renderer instead of conditionally reading the same ID from global open-conversation state.

No thresholds were changed, no coverage exclusions were added, and no ignore directives were added.
