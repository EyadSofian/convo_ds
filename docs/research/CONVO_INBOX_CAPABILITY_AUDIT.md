# CONVO Inbox capability audit

**Audited revision:** `9edd0048dcdc0325608b5afc65f964802af2c372`  
**Audit date:** 2026-09-22  
**Method:** source, migrations, contracts and existing tests were reviewed. No
production system and no customer data were accessed.

## Repository state

- `origin/main` and local `main` resolve to the audited revision above.
- The working tree was clean before this sprint branch was created.
- There were no open pull requests at the audit point.
- Migration high-water mark is `0033_account_security_events.sql`.
- The API is Nest/Fastify; the web app is TypeScript DOM rendering, not React.
- API contracts are pinned in the repository and route inventory tests enforce
  deliberate changes.

## Current Inbox behaviour

| Capability | Evidence | Current state |
| --- | --- | --- |
| Mine and all readable conversations | `ConversationService.list` and `ConversationController.list` | Implemented, but capped at 200 with no cursor |
| Unassigned preview queue | `ConversationService.unassigned` | Implemented as security-reduced queue cards; deliberately separate from full conversation records |
| Current filters | `GET /conversations`: status, unread, priority, channel, inboxId, teamId, assigneeId, repeated label | Server-side but flat, AND-only and no keyword/date/campaign/source/custom-field compiler |
| Sort | SQL `last_activity_at DESC, id` | Fixed newest activity only |
| List permission enforcement | `authorize(principal, 'conversation.read', ...)` per returned row | Correct security boundary, but currently incurs participant lookups per row |
| Saved Views API | `SegmentService`, `saved_views`, migration `0027` | Create/list/update/retire exists with private/team/workspace visibility; it validates the AST but no Inbox list compiler consumes it |
| Saved Views UI | `apps/web/src/ui/live-inbox.ts` and API clients | Incomplete/not present as an operational Inbox workflow |
| Contact/metadata | migrations `0016`, `0019`; `MetadataService` | Contacts, labels and typed contact/conversation custom fields exist |
| Collaborators/participants/handoff | migration `0018`, routing/lifecycle services | Stored distinctly: append-only participants, removable collaborator intervals, durable handoff offers |
| Assignment history | `conversation_audit` in `0018` | Append-only `claim`, `assign`, `unassign`, `handoff` and related facts; action source taxonomy is not a first-class column |
| Episodes | migration `0017`, `LifecycleService` | Durable per-work episode, with first inbound/first human response/close timing and correct reopen handling |
| Campaign reports | campaign reporting service and `0020`–`0025` | Campaign execution/recipient delivery reporting exists; general operations reports do not |

## Condition language: verified gap

`packages/domain/src/conditions/condition.ts` validates a versioned,
bounded condition AST: `ALL`/`ANY`, depth 4, at most 50 nodes and at most 20
children per group. It accepts closed operators (`eq`, `neq`, `in`, `not_in`,
`contains`, numeric/date comparisons and set checks) and a closed conversation
field vocabulary, including `custom.<uuid>`.

However, this is validation only for conversation Saved Views. There is no
conversation filter SQL compiler and `ConversationService.list` does not read a
Saved View's `conditions`. The present `campaign_name` condition token is not a
truthful deterministic campaign relationship and must **not** be exposed by the
new filter implementation. The sprint must replace it with `campaign_id` only
after a durable attribution rule exists.

## Data relationship audit

### Conversation and lifecycle

- `conversations` has tenant, connection, peer identity, current team/assignee,
  status, priority, `waiting_since`, `last_activity_at`, contact and version.
- `conversation_episodes` retains the opening, first inbound, first response
  and closing times. A reopen closes the prior episode and starts a new one;
  this is suitable for resolution reporting.
- `conversation_audit` is tenant-RLS/force-RLS and append-only by application
  grant. It is the source for historical assignment events, not the mutable
  current assignee column.
- `conversation_participants` is append-only evidence of activity; it is not a
  collaboration table. `conversation_collaborators` has explicit intervals.

### Labels and custom fields

- `conversation_labels` has an active-row predicate/index and supports exact
  membership filtering.
- Contact and conversation custom fields are typed and validated by metadata
  services. Existing indexes support selected exact value predicates. Text
  `contains` must be deliberately indexed/planned before exposure at scale.

### Campaign attribution

Existing deterministic campaign evidence is:

```text
campaign → campaign_execution → campaign_recipient → command_id
         → outbound_messages(connection_id, peer_identity)
```

`outbound_messages` does **not** hold `conversation_id`; a conversation can be
reconstructed by the current connection/peer identity, but archived/reopened
threads mean that is not an immutable historical attribution. Therefore an
Inbox campaign filter cannot honestly use `campaign_name`, and the current
relationship is insufficient to prove that a specific conversation contained a
particular campaign send.

The implementable definition is:

> A campaign-attributed conversation is one for which a durable record links a
> campaign recipient's accepted outbound command to the specific conversation
> that contained it. A customer reply is campaign-attributable only when it is
> in that linked conversation and occurred after the linked send.

One conversation may have multiple such links. The report/inbox predicate is a
stable `campaign_id`, with the human campaign name used only for display.

## Security and tenancy baseline

- Tenant context is set transaction-locally and RLS is enabled/forced on the
  relevant tables.
- Conversation list reads call `authorize` for each candidate using inbox,
  team, assignee and participant terms.
- Saved-view visibility is enforced server-side; team views are limited to the
  requesting principal's team scopes.
- Reports have the `report.read` permission but no operational-report endpoint
  yet. Any new report endpoint must derive its candidate data within the same
  transaction/tenant context and must not treat client-supplied IDs as scope.
- A supervisor context can narrow a supervisor's existing readable scope but
  cannot grant new access, replace the authenticated membership, or cause an
  action to be attributed to the selected agent.

## Language defect confirmed

`createState()` defaults `lang` to Arabic and `applyRoute()` overwrites state
from a route whose `lang` parameter is absent. `Preferences` only persists theme
and navigation state. Thus English selected in the running app can be lost when
a route is read again (including Automation draft deep links), causing Arabic
and RTL to return. Direction must remain a rendering consequence of
`state.lang`, never of a draft, contact or message body.

## Implement-now scope

1. Persist language (`convo.lang`) and hydrate it before the first protected
   render; add route handling that does not erase a persisted preference.
2. Introduce one typed Inbox filter catalogue and parameterised compiler for
   existing, evidence-backed dimensions: current status, assignment/team,
   connection/channel, labels, priority, unread, unreplied, dates, customer
   identity and supported custom fields.
3. Add cursor pagination, server-side keyword search and selectable operational
   sort. Preserve all selected query state on realtime refresh.
4. Make the existing Saved Views backend operational in the UI and compile
   validated view conditions with the same catalogue.
5. Add read-only Supervisor View and audit entry/exit. Authorised actions, if
   later enabled, retain the supervisor as actor.
6. Add only event/episode-backed agent, team, response, resolution and
   assignment reporting with written metric definitions and Inbox drill-down.
7. Add a durable campaign-conversation attribution table before exposing the
   campaign filter.

## Deferred until data/contract exists

- Presence/availability and capacity limits.
- SLA status/due/breach filters and SLA reports.
- Initial channel, first/last assignee, explicit assignment source categories
  not recorded by `conversation_audit`.
- Customer lifecycle status, unless a real field is introduced.
- Text-heavy search/custom-field predicates without a measured query plan.
