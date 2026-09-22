# Operational reporting metric definitions

**Status:** normative for the Inbox intelligence sprint. A dashboard must not
publish a metric that deviates from these definitions without a versioned change
to this document and its deterministic tests.

## Common rules

- All timestamps are UTC instants; UI presentation may use the viewer's locale.
- A date range includes events whose defining event timestamp is `>= from` and
  `< to + 1 calendar day` (or an equivalent explicit end-exclusive instant).
- Tenant and report permission scope are enforced before aggregation.
- **New in period** is based only on `conversations.created_at` inside the
  caller-readable scope. A later resolve/archive does not erase historical
  creation volume. The current active backlog is separate and excludes resolved
  and archived conversations.
- Bot/automation outbound messages do **not** count as human agent responses.
- Working hours are **not** applied in this version; display `calendar time`.
- A reopened conversation has a new `conversation_episodes` row. Historical
  metrics retain the closed episode and do not stretch it through a reopen.
- Inbound/outbound events created after migration 0036 retain their exact
  `conversation_id`. Historical null-bound rows use the documented temporal
  fallback in `REPORT_FILTER_SEMANTICS.md`; they are never backfilled by
  connection/peer identity. Archive intervals are half-open: an event at the
  archive instant is not owned by the archived conversation.

| Metric | Event/source table | Start → end | Agent attribution | Date-window rule | Reassignment/reopen treatment |
| --- | --- | --- | --- | --- | --- |
| Current assigned | `conversations.assignee_membership_id` | Current-state count | Current assignee only | Evaluated at request time, not date window | No historical inference; reopen may be current work again |
| Assignment events in period | `conversation_audit` acts `claim`,`assign`,`handoff` | Ownership-changing assignment event | `to_value` membership UUID | `conversation_audit.at` in range | Every valid target event counts; `handoff_requested`/declined/cancelled/expired do not count |
| Conversations handled | `outbound_messages` joined to conversation | Human outbound activity | `author_membership` | Message `created_at` in range | One conversation per agent per range; a reopen is not collapsed across unrelated agent activity |
| Resolved conversations | `conversation_episodes` plus lifecycle/audit evidence | Episode open → resolved | Actor that performed the resolution transition, only when stored evidence names one | Resolution event time in range | Each resolved episode counts; current assignee is never substituted |
| Unique customers | handled/resolved conversation joins `contacts` | n/a | Agent from qualifying action | Qualifying action in range | Count distinct `contact_id`; no identity auto-merge assumption |
| Messages sent | `outbound_messages` | n/a | `author_membership` non-null | `created_at` in range | Human only; campaign/automation rows with null human author excluded |
| Internal notes | `conversation_notes` | n/a | note author membership | `created_at` in range | Human-authored audit evidence only |
| First response time | `conversation_episodes` | `first_inbound_at` → `first_response_at` | Human author of first qualifying response where retained; otherwise report aggregate only | Episode closing/opening event in range, explicitly labelled by report | Each episode independently; no bot/automation response qualifies |
| Assignment → first response | `conversation_audit` + human outbound event | assignment `at` → first subsequent human outbound | Assignee target at assignment | Assignment timestamp in range | Each assignment event can have a measure; reassignment starts a distinct clock |
| Average response time | message chronology (future compiler) | qualifying inbound → next human outbound | Human outbound author | Response completion timestamp in range | No claim of a value until compiler and fixtures are implemented |
| Resolution time | `conversation_episodes` | `opened_at` → `closed_at` | Resolution actor only if lifecycle evidence proves it | `closed_at` in range | Previous closed episode remains final after reopen; reopened issue is new episode |
| Assignment → resolution | assignment audit + episode close | assignment `at` → relevant episode `closed_at` | Resolution actor, with assignment target dimension separate | Episode close in range | Each assignment is distinct; use last qualifying assignment only when report says “last assignment” |
| Reassignments | `conversation_audit` `assign`/`handoff` after prior assignee | n/a | Actor and target shown separately | audit `at` in range | Count actual events, never a current-state difference |
| Reopened after resolution | episode transition evidence | prior close → new episode open | No agent attribution unless explicit transition actor is retained | New episode `opened_at` in range | Count new episodes with `reopened_from_id`/equivalent lifecycle evidence |
| Channel activity | Exact conversation-bound messages and episodes | Metric-specific event evidence | Authored/episode actor where a breakdown is shown | Same timestamp as the underlying message or episode | Channel is the conversation's channel; campaign delivery remains a separate report |

## Aggregation rules

- **Average** is arithmetic mean of qualifying non-negative durations.
- **Median** is PostgreSQL `percentile_cont(0.5)` over the same qualifying set.
- Response-time buckets are `<5m`, `5–15m`, `15–30m`, `30–60m`, and `>60m`;
  thresholds are calendar elapsed time and use the same measured first-response
  episodes as average and median.
- Empty qualifying sets render `—`, not zero.
- Drill-down rows are the exact events/episodes that met the aggregate's filter;
  no client-side reconstructed set is allowed.
