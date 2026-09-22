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

Exact local PostgreSQL fixture results from the latest clean run. `Buffers` is
the root plan's shared buffer hits. All read plans use the real compiler and
the 51-row query shape (`limit + 1`); no timing assertion is used in CI.

| Query shape | Fixture selectivity | Dominant plan / behavior | Buffers | Execution | Decision |
| --- | --- | --- | ---: | ---: | --- |
| Contact name infix | common `nadia` | tenant contact index, filter/sort | 297 | 1.049 ms | keep |
| Contact list | all contacts | tenant contact index, top-N | 297 | 1.653 ms | keep |
| Inbox activity, first | 10k live | connection tenant scans, top-N | 6,265 | 3.037 ms | keep |
| Created / priority / waiting, first | 10k live | keyset-compatible top-N | 5,162 | 2.494 / 3.140 / 2.461 ms | keep |
| Activity cursor middle / late | rows ~4k / ~8k | keyset predicate before `LIMIT` | 5,162 | 1.863 / 1.847 ms | keep |
| Created cursor middle / late | rows ~4k / ~8k | keyset predicate before `LIMIT` | 5,162 | 1.937 / 1.533 ms | keep |
| Priority cursor middle / late | rows ~4k / ~8k | keyset predicate before `LIMIT` | 5,162 | 3.087 / 1.889 ms | keep |
| Waiting cursor middle / late | rows ~4k / ~8k | keyset predicate before `LIMIT` | 5,162 | 1.992 / 1.419 ms | keep |
| Scoped team / inbox | one of six / one of four | scope predicate before `LIMIT` | 5,162 | 1.803 / 1.403 ms | keep |
| Own team | assignment + participant + collaborator | bounded ownership subplans | 8,659 | 2.167 ms | keep |
| VIP / two-label ALL / three-label ALL | 20% / overlap / overlap | `conversation_labels_filter_idx`, correlated ALL aggregate | 27,162 / 48,866 / 69,496 | 9.604 / 13.642 / 17.447 ms | keep |
| Unread | 40% (none or behind read) | viewer read left join | 12,152 | 4.503 ms | keep |
| Unreplied true / false | 30% / 70% | bounded inbound/outbound evidence subplans | 66,662 | 19.955 / 20.377 ms | monitor |
| Agent + open / connection | 1/16 agent | assignee index | 136 / 129 | 0.075 / 0.045 ms | keep |
| Team + WhatsApp | one team, majority channel | team/channel predicates | 4,230 | 0.906 ms | keep |
| Agent + VIP / unreplied | 1/16 plus relation | assignee index then evidence | 785 / 1,134 | 0.310 / 0.470 ms | keep |
| Specific connection | one of four | live identity index | 5,310 | 1.619 ms | keep |
| Campaign + open | 1,200 attributed rows | one-time attribution array init-plan | 5,202 | 15.891 ms | keep |
| Campaign + agent + open | attributed + 1/16 agent | init-plan then assignee index | 179 | 0.290 ms | keep |
| Campaign + agent + label | attributed + selective relations | init-plan then selective evidence | 455 | 1.380 ms | keep |
| Campaign + unreplied | attributed + reply evidence | init-plan plus bounded subplans | 12,669 | 20.832 ms | monitor |
| Custom text exact / contains | 5% / 55% | field-value index / typed filter scan | 4,007 / 48,022 | 0.841 / 9.237 ms | keep |
| Custom select / boolean / date | 33% / 50% / 64% | `conversation_field_values_filter_idx` | 24,527 / 36,062 / 44,917 | 4.854 / 7.177 / 9.267 ms | keep |
| Search UUID / common name | rare / 10% | Inbox scan + bound contact/identity subplans | 35,193 / 35,196 | 8.322 / 8.085 ms | monitor |
| Peer identity rare / common | rare / all | same search path / peer predicate | 34,896 / 5,162 | 8.283 / 3.134 ms | keep |
| Customer phone exact | one seeded identity | identity subplan | 26,362 | 7.662 ms | monitor |
| Team + unreplied + waiting | one team + 30% | team scan + bounded reply evidence | 15,664 | 4.664 ms | keep |
| Unread + high + WhatsApp | 40% + 20% + channel | read join + channel/priority | 5,230 | 1.099 ms | keep |
| Two-label ALL + agent | label overlap + 1/16 | assignee index + ALL aggregate | 3,044 | 0.963 ms | keep |

## Changes justified by the evidence

Two query forms were materially wrong at this volume, without requiring a new
index:

1. Custom-field filters selected a scalar correlated `value_json` subquery for
   each of 10,000 conversations. Exact text took **1,363.808 ms** and boolean,
   select and date cases took approximately **1.33–1.40 s**. The compiler now
   uses `EXISTS` against the stored typed `search_value`. PostgreSQL starts with
   the existing `(tenant_id, field_id, search_value, conversation_id)` index;
   exact text is now **0.841 ms**. The stored representation is specifically
   normalized for matching, so the change also keeps case/diacritic matching
   consistent with metadata writes.

2. A correlated campaign `EXISTS` caused PostgreSQL to scan the 1,200 campaign
   attributions once per open conversation: roughly 9.5 million shared-buffer
   hits and **~1.0 s** locally. The compiler now materializes the campaign's
   bound conversation IDs once via an array init-plan. The existing
   campaign-attribution index is sufficient; campaign+open is now **15.891 ms**.

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
