# Operational report filter semantics

**Status:** normative for implemented report queries. A filter is not applied to
a metric until that endpoint validates it and its metric-specific predicate is
covered by tests. No report accepts arbitrary SQL/JSON predicates.

## Common scope and event rules

- Tenant isolation and the caller's readable conversation scope are applied
  before aggregation. A report principal is never replaced by the selected
  agent's principal.
- An `own` `report.read` grant authorizes only the caller's own report; the
  report query still applies that caller's own-readable conversation scope to
  every aggregate and identity directory.
- Date ranges use the metric's event timestamp and a half-open interval:
  `timestamp >= from AND timestamp < toExclusive`.
- Human outbound events are rows with a non-null `author_membership`, excluding
  explicit campaign test sends. Campaign, automation, and system messages are
  not agent messages.
- New inbound/outbound rows are bound to `conversation_id` when normalized or
  authored. That binding is authoritative even if an inbound provider timestamp
  predates conversation creation.
- Historical rows with a null binding are resolved using a half-open
  conversation interval. Outbound ownership starts at `conversations.created_at`;
  inbound opening events may start at the first episode's `first_inbound_at`
  because normalization follows webhook journaling. Ownership ends strictly
  before `archived_at`. If delayed legacy events make eligible intervals overlap,
  the latest eligible interval start wins, with conversation UUID as a stable
  tie-break. This fallback is report-time only; historical rows are not
  backfilled by peer identity.

## Metric dimensions

| Metric | Date dimension | Agent filter | Team filter | Channel / connection | Label | Campaign | Priority / status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current active backlog / unassigned | Request-time state | Current assignee | Current `conversations.team_id` | Conversation's current connection and channel kind | Current conversation-label assignment | Durable conversation attribution | Current priority / status |
| New conversations | `conversations.created_at` | No historical agent attribution; only a conversation currently assigned to the selected agent if an endpoint explicitly requests that dimension | Current team at query time only | Conversation's connection / kind | Current conversation-label assignment, not label-at-creation | Durable attribution, not causal campaign credit | Current values only when the endpoint explicitly labels them as current-state dimensions |
| Assigned in period | `conversation_audit.at` | Assignment target (`to_value`) for `claim`, `assign`, and ownership-changing `handoff` only | Current team membership grouping only; no event-time team claim | Conversation associated with the audit event | Current conversation-label dimension only | Durable conversation attribution; does not claim campaign caused assignment | Event row's conversation current value only when disclosed as current state |
| Handled conversations | Human `outbound_messages.created_at` | Human outbound author | Current team membership of that author, explicitly a current-membership grouping | Event's exact conversation connection / channel | Current label on that conversation | Durable attribution to the conversation, not causal action attribution | Conversation current values only if explicitly presented as current dimensions |
| Human messages | `outbound_messages.created_at` | `author_membership` | Current team membership of author, not historical team at event time | Event's exact conversation connection / channel | Current label on that conversation | Durable attribution only | Conversation current values only if explicitly presented as current dimensions |
| Internal notes | `conversation_notes.created_at` | `author_membership_id` | Current team membership of author | Note's conversation connection / channel | Current label on that conversation | Durable attribution only | Conversation current values only if explicitly presented as current dimensions |
| First response | `conversation_episodes.first_response_at` | `first_response_by_membership_id`; null actor is unattributed | Current team membership of the proven response actor | Episode conversation connection / channel | Current label only | Durable attribution only | Episode conversation current values only if explicitly presented as current dimensions |
| Resolution | `conversation_episodes.closed_at` | `closed_by_membership_id`; null actor is unattributed | Current team membership of the proven closer | Episode conversation connection / channel | Current label only | Durable attribution only | Episode conversation current values only if explicitly presented as current dimensions |
| Reassignment | `conversation_audit.at` | Ownership-changing event target; reassignment additionally requires non-null prior owner and a different target | Current team membership grouping only | Conversation associated with the event | Current label only | Durable attribution only | Current conversation state only if separately labelled |
| Assignment log | `conversation_audit.at` | Target/actor are separate columns; filter semantics must name which role is selected | No historical team attribution without event-time membership evidence | Conversation's connection / channel | Current label only | Durable attribution only | Event conversation current values only if disclosed |
| Teams report | Current workload at request time; historical activity uses its event timestamp | Current assignee for workload; human author / proven episode actor for activity | Team members **now**, explicitly labelled Current team grouping | Conversation's current connection / channel | Current conversation label | Durable conversation attribution, not causal credit | Current conversation values |

## Entity filter validation

- `agentId` is a membership UUID and must occur in the caller's shared,
  scoped-reportable-agent directory. It never means current assignee for
  historical authored/episode metrics.
- `teamId` must be inside caller-permitted report scope. Current workload uses
  the conversation's current team. Agent activity grouped by team uses current
  `team_members` and is labelled **Current team membership**; this is not
  historical team ownership.
- `connectionId` must be a readable Inbox connection for the report principal.
  `channel` is a closed enum of connection kinds.
- `labelId` must belong to the tenant. Until label history is stored, it means
  the conversation currently has that label, not that it had it when the event
  occurred.
- `campaignId` must belong to the tenant and is matched only through durable
  `campaign_conversation_attributions`. It does not imply campaign causality.
- `priority` and `status` are closed enums, never free-form predicates.
- Out-of-scope and cross-tenant entity IDs use generic validation/not-found
behavior and must not disclose whether an entity exists elsewhere.

The dedicated Teams report returns only team identities visible through the
report principal's tenant/team/Inbox scope. A scoped manager never receives
other tenant team names with zeroed metrics. Its `activeAgentCount` is the
number of active, reportable memberships currently on the team. Historical
message and episode activity is grouped by current `team_members`; this is a
present-day grouping and cannot be interpreted as the team that owned the work
when the event occurred. Current backlog remains grouped by
`conversations.team_id` at query time. Team → Inbox links filter by the
canonical `team_id` field.

Unsupported filters are rejected rather than silently ignored. Filter support
is added per metric only with server-side predicates and scope/security tests.

## Deliberately deferred metric

Assignment-to-first-response is not published until the system can pair an
ownership-changing assignment interval with a human response by that same owner
before the next ownership change. A reassignment before response leaves the
earlier interval unmeasured; current assignment is not a substitute.
