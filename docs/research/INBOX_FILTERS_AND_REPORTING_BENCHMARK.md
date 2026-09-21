# Inbox filters and reporting benchmark

**Research date:** 2026-09-22  
**Purpose:** establish product patterns that CONVO can adopt without copying a
vendor's interface or claiming data it does not retain. This is feature research,
not a claim of parity with any referenced product.

## Primary sources

- [respond.io — Filtering and Sorting Conversations in Inbox](https://respond.io/help/inbox)
- [respond.io — Reports: Users](https://respond.io/help/dashboard-reporting/reports-users)
- [respond.io — Reports Overview](https://respond.io/help/dashboard-reporting/reports-overview)
- [Intercom — Inbox search and filter](https://www.intercom.com/help/en/articles/6516006-inbox-search-and-filter)
- [Intercom — Custom Inbox views and folders](https://www.intercom.com/help/en/articles/6588834-organize-your-inbox-with-custom-views-and-folders)
- [Intercom — Monitoring workload and capacity](https://www.intercom.com/help/en/articles/6560699-monitoring-your-team-s-workload-and-capacity)
- [SleekFlow — Conversation Analytics](https://help.sleekflow.io/en_US/analitik-percakapan)
- [SleekFlow — Navigating and managing conversations](https://sleekflow.helpjuice.com/inbox/managing-conversations-in-inbox)
- [Front — Views](https://help.front.com/en/articles/2243)
- [Front — Analytics views](https://help.front.com/en/articles/2146)
- [Front — Live dashboard](https://help.front.com/en/articles/1146752)

## Product findings

All four products treat an inbox view as a *work queue*, not as an action that
changes ownership. Intercom explicitly distinguishes a filtered view from the
team/person to whom the conversation remains assigned. Front makes views useful
for monitoring a teammate's workload without impersonating that teammate.

The common operational pattern is therefore:

1. structured filters and keyword search compose with an existing queue;
2. saved views preserve a useful query and have an explicit visibility model;
3. live workload is a current-state read, while performance reporting is an
   event/episode read over a selected period;
4. agents and teams are dimensions with different meanings; an assignee filter
   must not be silently substituted for a team filter; and
5. heavy text/custom-value predicates are bounded and server-side. Intercom
   documents rate limiting of complex concurrent views and recommends using
   indexed/structured values such as tags where possible.

## Benchmark matrix

| Filter/reporting feature | Platform pattern | Value for CONVO | Data exists in CONVO today | Recommendation |
| --- | --- | --- | --- | --- |
| Status, assignee, team, channel, tags/labels | All four expose structured selectors; categories combine predictably | Core operational queue narrowing | `conversations`, `channel_connections`, `conversation_labels`, memberships, teams | **Implement now** through a typed server compiler |
| Mine / All / Unassigned queues | respond.io and Intercom make these first-class | Fast triage without inventing a new query language | Existing `/conversations` and `/conversations/unassigned` | **Adapt now**; keep different security semantics of queue cards vs readable records |
| Keyword search composed with filters | Intercom scopes keyword search to a current view; structured filters compose | Find a customer or issue without losing scope | Contact identity/name and message history exist, but no safe search endpoint | **Implement now** with bounded, permission-scoped PostgreSQL search |
| Current versus initial channel | Intercom exposes both when retained | Important when channels can change | Current connection is retained; no immutable initial-channel column | **Later**; do not invent historical channel data |
| Unread and unreplied | respond.io/SleekFlow use operational attention states | Clear next-work indicators | Per-member `conversation_reads` exists; unreplied can be derived from inbound/outbound chronology | **Implement now**, with written definitions |
| Date / last activity / waiting age | All products support date or aging views | Backlog prioritisation | `created_at`, `last_activity_at`, `waiting_since` exist | **Implement now** |
| Custom conversation/contact fields | Intercom and Front use typed attributes | Client-specific segmentation without schema forks | Typed field catalog and values exist | **Implement now** for supported scalar field types, parameterised SQL only |
| Collaborator/participant/handoff filters | respond.io distinguishes collaborator from assignee | Prevents false ownership conclusions | participants, collaborator intervals and handoff offers exist | **Implement now** where permissions allow; never alias collaborators to assignees |
| Campaign filter | Campaign tools commonly report attributable replies | Requested campaign follow-up queue | Recipient → command → outbound evidence exists; conversation link is only indirect by connection/peer identity | **Adapt after durable attribution link**; no fuzzy `campaign_name` filter |
| Source filter | Mature tools expose source only when it is evidence-backed | Separates customer work from campaigns/workflows | `conversation_episodes.opened_by` gives inbound/outbound origin; no complete per-conversation source ledger | **Later / partial**: expose only verified episode origin, not a broad claimed taxonomy |
| AND quick filters / bounded ALL-ANY saved views | Intercom has AND/OR view filters; respond.io custom inboxes retain rules | Fits CONVO's existing condition AST | `ConditionDocument` supports bounded groups (depth 4, 50 nodes) | **Implement now**, after compiler parity tests |
| Private/team/workspace saved views | Front distinguishes private/workspace; Intercom gates view management | Appropriate collaboration model | `saved_views` supports all three and is RLS-protected | **Finish UI now**; preserve server ownership/manage checks |
| Agent workload observation | Front/Intercom show manager workload and drill-down | Enables supervision without unsafe impersonation | Assignments and scoped `conversation.read` exist | **Implement now** as read-only supervisor context; authenticated actor remains supervisor |
| Agent performance table | respond.io Users report gives assignment, close, messages, comments and time metrics | Actionable coaching and capacity analysis | Assignment audit, outbound author, notes, and lifecycle episodes exist | **Implement now** only for metrics with a documented source/attribution rule |
| Team performance | Intercom separates team and teammate reports | Avoids mixing a team queue with human actions | Teams and assignment/team fields exist | **Implement now** with explicit current versus historical meaning |
| Assignment history log | respond.io reports assignments; Front drills workload to work items | Auditable workload changes | Append-only `conversation_audit` records claim/assign/unassign/handoff | **Implement now**; source labels only where evidence exists |
| First response / resolution / reopen metrics | respond.io and SleekFlow document time metrics; Intercom can exclude bot time | Customer responsiveness and service quality | `conversation_episodes` has first inbound/response and closed timestamps | **Implement now** using episodes; publish bot/working-hours treatment explicitly |
| Live capacity / availability | Intercom/Front have live dashboards | Useful only when presence/capacity is real | No durable agent presence or capacity model | **Adapt**: show current assigned/open/waiting/unread counts; **do not show availability/capacity** |
| SLA filters and dashboards | Intercom supports SLA views | Valuable once a true SLA clock is active | Schema documents SLA clock concepts but no verified active runtime/report API in this branch | **Later**; do not display a synthetic SLA state |
| Cross-report saved filter sets | Front uses shared analytics views | Consistency across reports | Saved views are resource-specific; no shared report filter model | **Adapt now** through a typed filter catalogue, not an untyped JSON reuse |

## Decisions carried into this sprint

- Adopt compact structured chips, an explicit “Add filter” catalogue, server
  pagination and a default newest-activity sort.
- Preserve **AND** semantics for the quick Inbox toolbar; reserve bounded
  `ALL`/`ANY` trees for the Saved View editor.
- Make report filters server-side and let useful aggregates drill into the same
  Inbox filter model.
- Use agent actions and assignment events for historical metrics. Current
  assignee is only a current-workload measure, never evidence of who resolved
  an earlier episode.
- Do not copy proprietary labels, report definitions or UI chrome. Do not add
  agent availability, SLA facts, initial channel, campaign attribution, or
  lifecycle fields until CONVO stores evidence for them.

## Rejected or deferred patterns

- Client-side filtering of a broad conversation set: unsafe for scope and
  unsuitable at scale.
- Silent “view as agent” authentication/session substitution: unsafe and
  misleading in audit history.
- Unlimited arbitrary query expressions: incompatible with CONVO's bounded
  condition-tree and parameterised-SQL security model.
- Textual campaign-name matching: cannot establish campaign causation.
- Treating collaboration as assignment: changes both access and accountability.
