# Inbox Query Performance Evidence

Date: 2026-09-22
Scope: the normal Inbox read path, measured locally against PostgreSQL with
tenant RLS enabled. These figures diagnose query shape; they are not a Railway
capacity claim.

## Reproducible fixture

`pnpm exec vitest run --project load tests/load/explain.test.ts` creates a
scratch database with 10,000 conversations, 10,000 contacts and two timeline
messages per conversation, runs `ANALYZE`, and executes `EXPLAIN (ANALYZE,
BUFFERS, COSTS)` in a real tenant context.

## Findings

| Query | Observed plan | Execution time | Decision |
| --- | --- | ---: | --- |
| Normal Inbox, activity descending | tenant-scoped bitmap heap scan followed by top-N sort | 1.726 ms | No new index yet. |
| Customer infix search (`nadia`) | `contacts_name_idx` bitmap scan, then bounded in-memory filter/sort | 0.961 ms | No trigram index. |
| Customer list without a search term | same tenant index and top-N sort | 1.438 ms | No index change. |

The normal Inbox query deliberately includes `status <> 'archived'`, matching
the product decision that archived history is outside normal Inbox. An
experimental partial `(tenant_id, last_activity_at DESC, id DESC)` index still
produced a bitmap scan and top-N sort at this volume (1.683 ms). The sub-3%
difference is within local-run noise and did not eliminate the measured sort,
so the experiment was discarded rather than committed.

The current fixture is retained as a regression harness. Targeted high-volume
fixtures for label-ALL, read state, unreplied, assignment/team/channel and
campaign-attribution predicates remain required before adding any index for
those paths. They must seed the actual related evidence; an empty-table plan is
not performance proof.

## Metadata reads

The conversation page previously performed two metadata relation reads per
conversation; a 50-row page therefore produced 100 metadata reads. The list
path now uses `conversationMetadataBatch`: the integration count test proves
the same 50-row request produces exactly **two** relation reads (labels and
custom fields), independent of page length.
