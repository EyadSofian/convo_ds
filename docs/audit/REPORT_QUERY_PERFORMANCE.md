# Reporting Query Performance Evidence

Date: 2026-09-22

Scope: local PostgreSQL 17, 10,000 synthetic conversations, 10,000 contacts,
about 9,000 human outbound events with legacy-null conversation bindings,
10,000 durable response episodes (with resolution evidence on resolved
conversations), 10,000 ownership audit rows, 16 active memberships, six teams,
four connections, and 1,200 durable campaign attributions. Plans run under the
tenant RLS context with `EXPLAIN (ANALYZE, BUFFERS, COSTS)`. These are local
diagnostic measurements, not a Railway or production latency claim.

Reproduce with:

```sh
pnpm exec vitest run --project load tests/load/explain.test.ts
```

The fixture uses real relation shapes and the canonical conversation-event
boundary. Report query rows below are representative SQL projections for each
metric, not HTTP end-to-end latency. Assignment pages use the audit table's
descending `(at,id)` keyset predicate at first, middle, and late cursors.

| Query | Fixture | Execution | Shared buffer hits | Dominant behavior | Problem? | Index tested / decision |
| --- | --- | ---: | ---: | --- | --- | --- |
| Overview | 10k conversations across 4 connections | 3.242 ms | 6,542 | Aggregate current backlog and 30-day creation volume | No | None; existing conversation/connection indexes sufficient for this projection |
| Agents | 16 memberships; 10k legacy-null human events | 20.460 ms | 81,655 | Zero-inclusive membership join plus temporal event ownership for authored activity | Monitor; most expensive agent projection | No index proposed: existing source tables are small at this fixture, and event ownership subplans dominate rather than a demonstrated missing index |
| Agent detail current workload | 625 conversations assigned to selected agent | 0.118 ms | 281 | Assignee index lookup | No | Existing `conversations_assignee_idx` sufficient |
| Teams current workload | 6 teams / 10k conversations | 2.158 ms | 1,448 | Team-scoped aggregate | No | Existing team and conversation indexes sufficient |
| Responses | 10k episode timings | 3.988 ms | 876 | Aggregate + median over response episodes | No | No index; episode scope join is bounded and current plan is small |
| Resolutions | 1,428 closed episodes | 1.902 ms | 868 | Aggregate + median over closed episodes | No | No index; no demonstrated indexing problem |
| Assignments first page | 10k audit rows | 9.332 ms | 50,291 | Ownership-action filter and descending page sort | Monitor buffer work; local execution remains low | No index yet; capture the service's fully scoped SQL plan before proposing one |
| Assignments middle cursor | cursor at approximately row 4k | 5.968 ms | 22,236 | Keyset predicate plus ownership-action filter | No latency issue observed | No speculative index |
| Assignments late cursor | cursor at approximately row 8k | 2.009 ms | 6,786 | Keyset predicate narrows remaining page candidates | No | No index; cursor depth reduces scanned rows |
| Channels | 10k conversations / 9k human events | 20.895 ms | 53,810 | Separate current backlog and conversation-bound human activity aggregates by channel | Monitor; event ownership is the dominant scan | No index: test data deliberately uses historical null bindings and does not prove a missing-index cause |

## Interpretation

At this fixture, timing calculations and current agent workload are inexpensive.
The widest work is the expected historical-event attribution needed to avoid
peer-history leakage. The seeded outbound rows intentionally have no stored
`conversation_id`, so the canonical temporal fallback is exercised; newly
created message rows with durable conversation binding take the direct
conversation path. No index was added: the evidence does not isolate an
indexable scan as the cause, and changing indexes without a before/after query
would be speculative.

This harness complements, but does not replace, integration security tests or
the Inbox performance fixture in `INBOX_QUERY_PERFORMANCE.md`. Before changing
indexes, capture the exact production-shaped endpoint SQL with tenant filters,
scope predicates, labels/campaign dimensions, and realistic traffic statistics.
