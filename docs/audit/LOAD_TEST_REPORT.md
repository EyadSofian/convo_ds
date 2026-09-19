# Load test report

## Railway staging production-shape curve (2026-09-17)

The authenticated public staging origin was exercised with the same mixed read
paths an operator uses (session, memberships, inbox list/detail/messages,
contact search, automations, campaigns and realtime catch-up). A serialized
write probe followed each level. Results include the Railway edge, web proxy,
API and managed PostgreSQL:

| concurrent operators | requests | req/s | p50 | p95 | p99 | errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 169 | 30.73 | 250.3 ms | 565.1 ms | 866.3 ms | 0 |
| 25 | 432 | 72.80 | 249.9 ms | 584.9 ms | 895.9 ms | 0 |
| 50 | 850 | 138.53 | 262.9 ms | 544.1 ms | 683.7 ms | 0 |
| 100 | 1,048 | 123.02 | 334.0 ms | 1,349.8 ms | 2,393.2 ms | 0 |

Writes returned 201 at every level; the 100-user run also completed priority,
close and reopen transitions. Throughput peaks at 50 and tail latency expands
at 100. Platform samples taken after the curve showed low CPU and memory rather
than a compute ceiling: API 0.0758 vCPU / 157.2 MB; PostgreSQL 0.1069 vCPU /
194.4 MB. PostgreSQL had 15 of 100 connections, one active. These are
post-curve platform samples, not peaks.

The observed bottleneck is client-visible shared-path latency, not demonstrated
CPU, memory or connection exhaustion. Until continuous telemetry can identify
its exact component, the safe initial envelope is **25 simultaneously active
operators**, with two API replicas for availability. Scale/retest when p95 is
over 750 ms for five minutes, error rate exceeds 1%, API CPU exceeds 70%, API
memory exceeds 75%, database connections exceed 70, or queue age crosses the
limits in `docs/runbooks/ALERTING.md`.

A controlled 200-event inbound burst was also committed atomically to staging.
The inbound worker normalized 40 after one second, 160 after two, and all 200
by the third observation; no event was quarantined and the queue returned to
zero. This is approximately 80 events/second over the measured drain interval.
All five queues were empty afterward. Other worker classes had current ticks
and zero errors, but no production-provider send throughput is claimed.

## GitHub-backed staging follow-up (2026-09-18)

### SSE connect, replay and controlled reconnect

The immutable GitHub-backed release was exercised through the public staging
edge with fresh authenticated sessions. This was a bounded reliability probe,
not a denial-of-service test.

| Concurrent SSE connects | Connected | setup p50 | setup p95 | maximum |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 429.7 ms | 639.0 ms | 639.0 ms |
| 25 | 25 | 402.5 ms | 432.8 ms | 434.9 ms |
| 50 | 50 | 478.6 ms | 797.0 ms | 1,437.0 ms |

Three immediate reconnect rounds of 10 clients all connected; setup p95 was
379.8, 345.2 and 359.2 ms. A controlled event followed by a reconnect with
`Last-Event-ID` replayed two distinct `conversation.routing` events with no
duplicate client-visible event identity. Multiple frames can legitimately
share one page cursor; correctness was therefore checked by event identity,
not cursor cardinality.

Restarting the staging API caused an established stream to disconnect and a
new authenticated stream recovered in 21.8 seconds, including deployment
restart time. The session remained valid. Ten clients then reconnected with a
391.2 ms p50 and 1,462.2 ms p95/maximum. Memory, database-load and event-loop
time series were not available at sufficient resolution during this short
probe, so they are not claimed. The conservative pilot threshold is **25 live
SSE sessions per API replica** and reconnect bursts of no more than 10 clients;
alert and scale if connection setup p95 exceeds one second for five minutes.

### Locating the 100-concurrency tail

A focused probe sent 500 public instance reads at each of 50 and 100
concurrency. Both levels completed with zero errors:

| concurrency | throughput | client p50 | client p95 | client p99 | max |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 125.89 req/s | 229.1 ms | 921.4 ms | 1,008.4 ms | 1,871.3 ms |
| 100 | 138.48 req/s | 241.1 ms | 1,213.4 ms | 1,942.3 ms | 3,364.9 ms |

For the correlated sample, API request logs showed 600 retained route samples
at p50 1 ms, p95 2 ms, p99 3 ms and maximum 5 ms (Railway log-rate limiting
dropped 400 otherwise successful log records). Railway HTTP observations over
1,001 requests showed total p50 3 ms, p95 12 ms, p99 31 ms and maximum 48 ms;
reported upstream duration was p50 2 ms, p95 11 ms, p99 31 ms and maximum 48
ms. There were no application or edge errors. The edge region was `us-west2`
while the load generator was in Cairo.

The evidence rules out route execution, database work and the measured Railway
upstream as the source of the seconds-long client tail for this route. The
remaining delay is outside the application, between the remote client and the
Railway edge (network/TLS/connection scheduling); this probe cannot divide
those components further. No architecture or pool change is justified by this
result. The approved 25-operator pilot envelope remains appropriate.

## Local diagnostic curve

These numbers were measured on a **local developer machine**, with the client
and the server on the same host and PostgreSQL on a local socket. Network
latency is therefore zero, there is no Railway CPU share, no hop between
services, and no managed-database tuning.

**They are not a production capacity figure, and nothing here should be quoted
as one.** Any sentence of the form "CONVO supports N users" would be a
fabrication until the same harness has been run against a staging environment
on the real platform.

## 2026-09-17 verification rerun

The current local evidence is `docs/evidence/load-test-latest.json`. With 10,000
conversations, 10,000 contacts, and five messages per conversation, it recorded
0% errors at every level:

| concurrency | requests | requests/s | worst scenario p50 | worst p95 | worst p99 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 46,437 | 4,643.24 | 4.27 ms | 5.52 ms | 6.78 ms |
| 25 | 45,126 | 4,511.25 | 9.28 ms | 10.46 ms | 11.78 ms |
| 50 | 38,777 | 3,874.21 | 17.08 ms | 18.92 ms | 21.19 ms |
| 100 | 38,484 | 3,839.95 | 32.67 ms | 36.05 ms | 38.70 ms |

An earlier staging probe exercised 1,200 authenticated mixed GET requests at
concurrency 20 with 0 errors (p50 243.0 ms, p95 602.1 ms, p99 1,117.7 ms). A
separate 90-second soak completed 880 requests with zero errors and a 4,396.6
ms maximum. The production-shape curve above supersedes that probe for capacity
planning.

What they *are* good for is the thing that does transfer: the **relative** cost
of endpoints, how each one scales with row count and concurrency, and where the
bottleneck is. That is what found and fixed the defect below.

## Environment

| | |
| --- | --- |
| Harness | `tests/load/` — closed-loop, Node, real HTTP over a real socket |
| Command | `pnpm test:load:target` |
| Tool | Written for this repository. k6 is not installed on this machine. |
| Node | v22.23.2, darwin/arm64 |
| PostgreSQL | embedded-postgres 17.4.0-beta.15, local socket, default tuning |
| API pool | `max: 10` (the HTTP-role setting) |
| Volume | 10,000 conversations · 10,000 contacts · 5 messages each |
| Duration | 20s per concurrency level, after warm-up |
| Levels | 10, 25, 50, 100 concurrent virtual users |
| Raw data | `docs/evidence/load-test-latest.json` |

The model is **closed-loop**: each virtual user waits for its answer before
issuing the next request, which is what an operator console actually is. An
open-model tool firing at a fixed arrival rate would report far worse tail
latency for the same server because it queues requests a real client would never
have sent.

Scenario weights approximate an agent's day — conversation list 5, open 3,
timeline 3, contact search 2, session 1, readiness 1.

Percentiles are nearest-rank over every sample, so a reported p99 is a duration
that was actually observed. Failed requests are counted **and** timed; dropping
their durations is how a server that fails fast under load appears to get
faster.

---

## The defect this found, and how it was nearly mis-diagnosed

The first run showed contact search at **27× the cost of every other endpoint**,
degrading superlinearly with concurrency while the others degraded linearly:

| Concurrency | conversation-list p50 | contact-search p50 |
| --- | --- | --- |
| 10 | 2.25 ms | **61.37 ms** |
| 25 | 6.18 ms | **171.65 ms** |
| 50 | 16.08 ms | **220.78 ms** |
| 100 | 45.01 ms | **231.28 ms** |

Throughput *fell* as concurrency rose — 4,454 → 4,169 → 2,891 → 2,269 rps —
which is saturation, not scaling.

**The plausible diagnosis was wrong.** `ContactService.list` filters with
`search_name LIKE '%' || $1 || '%'`. A leading wildcard cannot use a B-tree, so
the obvious reading was a sequential scan and the obvious fix a `pg_trgm` GIN
index. That index was written, migrated and measured. It moved p50 from 61.37 ms
to 59.66 ms — **under 3%** — and was removed again.

`EXPLAIN ANALYZE` at the same volume said why:

```
Limit  (actual time=0.998..1.007 rows=200 loops=1)
  ->  Bitmap Heap Scan on contacts  (actual time=0.247..0.861 rows=1000 loops=1)
        Filter: ((deleted_at IS NULL) AND (search_name ~~ '%nadia%'::text))
        Rows Removed by Filter: 9000
        ->  Bitmap Index Scan on contacts_name_idx (actual time=0.237 rows=10000)
Execution Time: 1.016 ms
```

**The search query takes 1.0 ms.** There was never a sequential scan: the RLS
tenant predicate already reduced the work to one company's contacts, and
filtering 10,000 rows in memory is a millisecond. The trigram index would have
cost write throughput on every contact rename and bought nothing.

The other 60 ms was round trips. `ContactService.list` called
`readMetadata(sql, 'contact', row.id)` once per row inside a `Promise.all` over
up to 200 rows — 2 queries each, **400 round trips for one request**.

**Fixed** by `readMetadataBatch`, which answers all 200 in two queries
(`metadata.service.ts`), called once alongside the already-batched identity
lookup (`contact.service.ts`).

### Result

| Concurrency | contact-search p50 before → after | p99 before → after |
| --- | --- | --- |
| 10 | 61.37 → **4.28 ms** (14.3×) | 86.97 → **6.59 ms** |
| 25 | 171.65 → **9.50 ms** (18.1×) | 239.53 → **15.78 ms** |
| 50 | 220.78 → **24.47 ms** (9.0×) | 464.71 → **31.60 ms** |
| 100 | 231.28 → **46.44 ms** (5.0×) | 296.66 → **53.96 ms** |

Throughput at 100 concurrent rose from 2,269 to 2,722 rps (+20%) while serving
**5× more** contact searches (1,106 → 5,573 samples). Tail latency tightened
too: p99/p50 went from 1.28 to 1.16, because the endpoint stopped monopolising
connections from a 10-connection pool.

---

## Measured results, after the fix

### 10 concurrent — 93,025 requests, 4,651 rps, 0% errors

| Scenario | p50 | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| conversation-list | 2.32 | 3.47 | 4.20 | 24,865 |
| conversation-open | 2.82 | 3.96 | 4.80 | 13,802 |
| message-timeline | 2.76 | 3.91 | 4.71 | 14,067 |
| contact-search | 4.28 | 5.37 | 6.59 | 4,563 |
| session-check | 1.09 | 1.88 | 2.51 | 16,975 |
| readiness | 1.00 | 1.58 | 2.11 | 18,753 |

### 25 concurrent — 84,129 requests, 4,205 rps, 0% errors

| Scenario | p50 | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| conversation-list | 6.58 | 10.00 | 11.35 | 23,268 |
| conversation-open | 7.78 | 11.94 | 13.19 | 12,242 |
| message-timeline | 7.40 | 11.29 | 12.76 | 12,897 |
| contact-search | 9.50 | 14.38 | 15.78 | 5,987 |
| session-check | 3.00 | 4.57 | 5.65 | 12,722 |
| readiness | 2.24 | 3.44 | 4.25 | 17,013 |

### 50 concurrent — 54,553 requests, 2,726 rps, 0% errors

| Scenario | p50 | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| conversation-list | 20.36 | 22.55 | 27.19 | 16,725 |
| conversation-open | 22.42 | 24.69 | 29.25 | 8,871 |
| message-timeline | 21.75 | 23.94 | 28.81 | 9,168 |
| contact-search | 24.47 | 27.28 | 31.60 | 5,670 |
| session-check | 10.79 | 14.13 | 15.96 | 5,459 |
| readiness | 6.62 | 9.98 | 11.35 | 8,660 |

### 100 concurrent — 54,513 requests, 2,722 rps, 0% errors

| Scenario | p50 | p95 | p99 | n |
| --- | --- | --- | --- | --- |
| conversation-list | 42.39 | 46.92 | 49.77 | 15,566 |
| conversation-open | 44.38 | 49.28 | 51.82 | 8,967 |
| message-timeline | 43.68 | 48.45 | 51.06 | 9,121 |
| contact-search | 46.44 | 51.15 | 53.96 | 5,573 |
| session-check | 25.56 | 30.50 | 33.13 | 5,472 |
| readiness | 13.63 | 19.57 | 21.37 | 9,814 |

**Zero errors at every level.** No 5xx, no timeouts, no pool exhaustion.

## Reading the curve

Throughput plateaus between 25 and 50 concurrent at roughly **4,200 rps**, and
past that latency rises roughly in proportion to concurrency while throughput
stays flat at ~2,700 rps. That is the signature of a saturated resource, and the
resource is the **API's 10-connection pool** (`startApi`, `max: 10` for HTTP
roles): at 100 concurrent requests against 10 connections, 90 are queueing, and
every latency above is mostly queue time.

That is a deliberate setting, not a defect — a larger pool per instance
multiplies against replica count and PostgreSQL's `max_connections`. The scaling
lever is **more API replicas**, not a bigger pool.

## Recommended initial production capacity

Stated as a recommendation with its basis, not as a measurement:

- **Start with 2 `convo-api` replicas.** One is a single point of failure during
  a deploy; the measured plateau gives no reason to start higher.
- **Plan for roughly 25–50 concurrent active operators per replica** as the
  region where latency stayed comfortably inside 30 ms locally. On Railway,
  expect materially worse — add the network hop, a shared CPU and a managed
  database. **Treat 25 per replica as the planning figure** until measured
  otherwise.
- For the customer's stated scale (a school's operations team, single digits to
  low tens of concurrent agents), **one replica is sufficient and two is the
  availability choice.**
- Watch `duration_ms` in the request log and the worker `/metrics`
  `offered`/`achieved` pair. Scale a role when `achieved` falls persistently
  below `offered`, not on CPU alone.

## What remains external or unmeasured

- **Real provider writes.** Meta and Resend credentials are not available, so
  external send throughput, provider throttling and receipt latency are not
  claimed.
- **SSE longevity.** Bounded 10/25/50-connect, rapid reconnect, replay and API
  restart behavior are now measured above. A many-hour slow-consumer run and
  high-resolution resource telemetry are not represented by this release
  probe.
- **Campaign and automation provider backlogs.** Their queues and worker probes
  were observed, while correctness, lease reclaim and idempotency are covered
  by integration tests. The shipped staging runtime deliberately has no fake
  success transport: it supports the refusing `none` adapter or real Meta.
  Consequently a 100/500/1,000 successful-send backlog test cannot be run
  honestly without provider assets and is not claimed.
- **Volumes above 10,000.** The mission suggested 100k conversations. Seeding
  10k takes 36s through the constraint-honouring path; 100k is a longer run
  rather than a different one, and is the obvious next step.
- **Resource ceilings.** Point-in-time CPU, RAM and PostgreSQL connections were
  sampled after the production-shape curve, but peak time series were not.

## Reproducing

```bash
pnpm test:load:target

# Bigger, longer, or a different curve:
CONVO_LOAD_CONVERSATIONS=100000 \
CONVO_LOAD_CONTACTS=100000 \
CONVO_LOAD_DURATION_MS=60000 \
CONVO_LOAD_LEVELS=10,25,50,100,200 \
pnpm test:load:target

# The plans behind the numbers:
npx vitest run --project load tests/load/explain.test.ts
```

The run asserts one thing and measures the rest: **zero failed requests**. There
are deliberately no latency thresholds — they would be thresholds on this
machine, and the first time CI ran on a busier one somebody would lower them
rather than investigate.
