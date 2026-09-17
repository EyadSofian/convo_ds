# Runbook: incident response

## First five minutes

Alert thresholds and severities are defined in `docs/runbooks/ALERTING.md`.

1. **Is it up?** `GET https://<public origin>/healthz` (web) and, from inside
   the private network, `GET http://convo-api.railway.internal:3000/ready`.
2. **Is it the database?** `/ready` returns `503` with
   `checks[0].code` of `unavailable` or `timeout` when PostgreSQL is the
   problem. `/live` stays `200` in that case — by design, so the platform does
   not restart every healthy instance at once during a database blip.
3. **Which way is it failing?** Filter the API's logs to
   `event=request_completed` and group by `status`. Every line carries
   `request_id`, `route`, `status` and `duration_ms`.
4. **Is work piling up?** The queue-depth queries below.

## Reading the logs

Every process emits one JSON object per line on stdout. The fields worth
filtering on:

| Field | Use |
| --- | --- |
| `event` | `request_completed`, `worker_tick_failed`, `process_started`, `boot_failed` |
| `request_id` | The same value the response returned in `x-request-id`. Ask the reporting user for it. |
| `route` | The route pattern, not the URL — so it aggregates. |
| `status`, `duration_ms` | Error rate and latency. |
| `process_role` | Which of the nine roles emitted it. |
| `worker_role`, `last_tick_at` | Worker health. |

Message content, tokens, passwords, API keys, cookies and authorization headers
are never logged — structurally, not by filtering. If you find one in a log,
that is itself a security incident.

## Worker health

Workers bind no API port but each serves probes on its configured port:

```
GET /live      -> the process exists
GET /ready     -> the loop has completed at least one tick
GET /metrics   -> ticks, handled, errors, offered, achieved, last_tick_at, last_error
```

A `last_tick_at` that has stopped advancing is a **wedged loop**, and it is the
one failure that looks identical to healthy idleness from every other angle.
Restart that worker; its leases expire and its work is reclaimed.

`offered` beside `achieved` is the starvation signal: when `achieved` is
persistently below `offered`, the round is not keeping up and the role needs
more replicas or more concurrency.

## Queue depth

```sql
-- Outbound: what is waiting, and how long the oldest has waited.
SELECT traffic_class, count(*) AS ready,
       extract(epoch FROM now() - min(available_at))::int AS oldest_seconds,
       count(*) FILTER (WHERE lease_until > now()) AS in_flight
  FROM outbox WHERE available_at <= now() GROUP BY traffic_class;

-- Inbound: journalled events no normalizer has picked up.
SELECT count(*) AS pending,
       extract(epoch FROM now() - min(received_at))::int AS oldest_seconds
  FROM channel_event_queue q JOIN channel_events e ON e.id = q.event_id;

-- Email.
SELECT state, count(*), extract(epoch FROM now() - min(created_at))::int AS oldest_seconds
  FROM email_deliveries GROUP BY state;

-- Automation runs that were materialized. NOTE: nothing executes these yet —
-- see the readiness report. A growing count here is expected, not an incident.
SELECT status, count(*) FROM automation_runs GROUP BY status;

-- Leases held by a worker that may be gone.
SELECT leased_by, count(*), min(lease_until)
  FROM outbox WHERE lease_until > now() GROUP BY leased_by;
```

## Common incidents

### Everybody is locked out of login

**Symptom:** every login returns `429 login_rate_limited`.

**Cause:** `CONVO_TRUSTED_PROXY_HOPS` is wrong. At `0` behind the web proxy,
every user shares one rate-limit bucket, so five failed attempts from anyone
locks out the whole installation for fifteen minutes.

**Fix:** set it to `2` on Railway (edge + web proxy) and redeploy the API. To
clear the block immediately:

```sql
DELETE FROM auth_rate_limits WHERE expires_at > now();
```

Setting it too high is the opposite failure — clients could then choose their own
bucket by sending a header and would never be limited.

### Invitations and password resets are not arriving

See `docs/runbooks/EMAIL_DELIVERY.md`. Check, in order: is
`convo-worker-integration` deployed and ready; is `email_deliveries` growing in
`pending`; what does `last_error_code` say on the `failed` rows.

A production API that boots at all has a configured provider — it fails closed
otherwise — so "no provider" is not a possible cause in production.

### Outbound messages are not sending

1. Is `CONVO_CHANNEL_TRANSPORT` set to `meta`? At `none` every send is refused
   with `provider_not_connected`, visibly, by design.
2. Is `convo-worker-interactive` ready and ticking?
3. `SELECT error_code, count(*) FROM outbound_attempts WHERE outcome <> 'accepted' AND completed_at > now() - interval '1 hour' GROUP BY error_code;`
4. See `docs/runbooks/META_WHATSAPP.md` for what each code means.

### Messages in `outcome_unknown`

These were sent to a provider that never answered. They **may have reached the
customer**. Nothing retries them automatically and nothing should: an automatic
retry is how one ambiguous message becomes two real ones.

```sql
SELECT m.id, m.peer_identity, m.state_reason, m.settled_at, a.error_code
  FROM outbound_messages m
  LEFT JOIN outbound_attempts a ON a.message_id = m.id
 WHERE m.command_state = 'outcome_unknown'
 ORDER BY m.settled_at DESC;
```

Resolve each by checking the conversation with the customer. This is a human
decision by design (ADR-0006).

### Webhook signature failures

A run of `signature_invalid` in `webhook_receipts` means the app secret in
configuration no longer matches the one Meta is signing with — usually a
rotation that updated one side only.

```sql
SELECT outcome, count(*), max(received_at)
  FROM webhook_receipts WHERE received_at > now() - interval '1 hour'
 GROUP BY outcome;
```

Inbound messages are being **lost** while this is happening: Meta retries for a
limited window and then stops. Treat as urgent.

### Database connections exhausted

Each HTTP role holds up to 10 connections; each worker holds
`max(4, CONVO_WORKER_CONCURRENCY)`. Total demand is that, times replicas, and it
must stay under the server's `max_connections`.

```sql
SELECT usename, application_name, state, count(*)
  FROM pg_stat_activity GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Reduce replicas or `CONVO_WORKER_CONCURRENCY`. Do not raise `max_connections`
without also sizing the memory each backend needs.

## Escalation

An incident is **severe** when any of these is true: inbound messages are being
lost; an outbound message may have reached a customer twice; one tenant can see
another's data; or credentials appear in a log. Every one of those is a data
incident, not an availability one — capture evidence **before** restarting
anything, because a restart destroys the in-flight state that explains it.
