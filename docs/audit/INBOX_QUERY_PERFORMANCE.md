# Inbox Query Performance Evidence

Date: 2026-09-22

Scope: local PostgreSQL 17 with FORCE RLS, measuring the SQL emitted by the
Inbox query compiler. These figures diagnose query shape at pilot-sized data;
they are not a Railway capacity claim.

## Reproduction

Run:

```sh
pnpm exec vitest run --project load tests/load/explain.test.ts
```

The existing load harness creates one tenant with 10,000 conversations and
10,000 contacts, then adds real, non-empty relational evidence before running
`ANALYZE` and `EXPLAIN (ANALYZE, BUFFERS, COSTS)` inside tenant context:

- four healthy connections (WhatsApp, Messenger, Instagram and Website Chat);
- 16 active agents, six teams, deterministic assignment and membership;
- 24 active labels, including overlapping VIP/Hot Lead/three-label cases;
- per-viewer reads, human and automation outbound messages, and participants;
- four typed conversation custom fields with values on every conversation;
- one campaign, revision, execution, recipients and 1,200 bound immutable
  campaign attributions.

The fixture chooses every relationship by stable row position. UUID values are
random database keys, but selectivity is deterministic. It is deliberately not
an empty-table plan.

## Measured query plans

The exact execution times from the latest clean local run are below. They vary
slightly between runs; plan shape and order of magnitude are the decision
evidence.

| Query | Dominant observed plan | Execution time |
| --- | --- | ---: |
| Contact infix search | tenant contact index + bounded filter/sort | 1.063 ms |
| Contact list | tenant contact index + top-N sort | 1.399 ms |
| Inbox, activity descending | connection-aware tenant scan + top-N sort | 3.828 ms |
| Inbox, keyset page 2 | same path with cursor predicate before `LIMIT` | 2.353 ms |
| Scoped reader, one team | team scope predicate before `LIMIT` | 1.292 ms |
| Own reader, one team | scope plus assignment/participant predicates | 2.811 ms |
| One label (VIP) | label ALL aggregate via `conversation_labels_filter_idx` | 8.894 ms |
| Two labels, ALL | same aggregate, two requested labels | 12.978 ms |
| Three labels, ALL | same aggregate, three requested labels | 16.865 ms |
| Unread | per-viewer `conversation_reads` left join | 3.898 ms |
| Unreplied = true | inbound/outbound aggregate evidence | 19.435 ms |
| Unreplied = false | inbound/outbound aggregate evidence | 19.221 ms |
| Agent + open | `conversations_assignee_idx` | 0.064 ms |
| Team + WhatsApp | team/channel predicates | 0.967 ms |
| Agent + VIP | assignee index plus label evidence | 0.280 ms |
| Agent + unreplied | assignee index plus reply evidence | 0.423 ms |
| Specific connection | live conversation identity index | 1.468 ms |
| Campaign + open | one-time campaign-attribution array, then Inbox scan | 15.909 ms |
| Campaign + agent + label | one-time campaign-attribution array plus selective predicates | 1.374 ms |
| Custom text, exact | `conversation_field_values_filter_idx` then conversation lookup | 1.109 ms |
| Custom text, contains | typed field scan/filter then conversation lookup | 9.423 ms |
| Custom single-select | field value index | 4.816 ms |
| Custom boolean | field value index | 7.166 ms |
| Custom date, after | lexically ordered ISO date search value index | 9.621 ms |
| Conversation UUID search | Inbox scan plus bound contact/identity subplans | 8.278 ms |
| Common customer-name search | Inbox scan plus contact subplan | 8.121 ms |
| Peer identity search | Inbox scan plus peer predicate | 2.741 ms |

## Changes justified by the evidence

Two query forms were materially wrong at this volume, without requiring a new
index:

1. Custom-field filters selected a scalar correlated `value_json` subquery for
   each of 10,000 conversations. Exact text took **1,363.808 ms** and boolean,
   select and date cases took approximately **1.33–1.40 s**. The compiler now
   uses `EXISTS` against the stored typed `search_value`. PostgreSQL starts with
   the existing `(tenant_id, field_id, search_value, conversation_id)` index;
   exact text is now **1.109 ms**. The stored representation is specifically
   normalized for matching, so the change also keeps case/diacritic matching
   consistent with metadata writes.

2. A correlated campaign `EXISTS` caused PostgreSQL to scan the 1,200 campaign
   attributions once per open conversation: roughly 9.5 million shared-buffer
   hits and **~1.0 s** locally. The compiler now materializes the campaign's
   bound conversation IDs once via an array init-plan. The existing
   campaign-attribution index is sufficient; campaign+open is now **15.909 ms**.

An experimental attribution lookup index did not change that bad semi-join
plan, so it was discarded. No speculative indexes were committed. The earlier
normal-Inbox activity index experiment remains rejected: it did not remove the
top-N sort and the difference was within local noise.

## Query-count evidence

The list projection performs one main Inbox SQL query. Metadata for a 50-row
page is exactly **two** set-based relation queries (labels and custom fields),
not 100 per-row queries; this is asserted in
`tests/integration/api-email.test.ts`. Therefore the projection portion is
three queries, independent of page length.

Authorization principal loading uses three bounded queries (membership, role
grants, scopes). Reference validation adds one bounded query for each present
filter family, and typed custom-field validation adds one query. Those are
intentionally separate from page cardinality: a normal Inbox request is six
queries end-to-end before HTTP serialization; a request with one custom-field
filter is seven. This report does not count logging or unrelated middleware.

## Follow-up thresholds

No additional index is warranted by this local 10k evidence. Re-run this
harness before any index proposal when a representative tenant exceeds the
fixture materially, or when observed database time for a supported Inbox filter
is consistently above the product's request budget. Search and `unreplied`
remain the widest local read paths; monitor them in staging/production telemetry
rather than adding an index solely because their SQL looks plausible to change.
