# ADR-0018: Worker topology, and decoupling scheduling from the broker

- Status: accepted
- Date: 2026-09-17
- Supersedes nothing. Amends the deployment consequence of ADR-0004.

## Context

The product ships one artifact that starts in one of several process roles. Five
of those roles are workers. Until this decision, `worker-integration` was defined
as "the process that publishes to the durable broker", and `main.ts` enforced
that with a single rule:

```ts
export function requiresBroker(role: ProcessRole): boolean {
  return role === 'worker-integration';
}
```

A process in that role checked `broker.healthy()` at boot and threw if the answer
was false. The bound broker is `unconfiguredBroker`, whose `healthy()` returns
`false` unconditionally, because this installation has never had a broker.

So `worker-integration` could not start. Correctly, on its own terms — a relay
with nothing to relay to is a process whose only job is impossible — and the
Railway topology reflects that by simply not deploying it.

Then the automation engine landed, and its schedule materialization was added to
that worker's tick:

```ts
async function integrationTick(context: WorkerContext): Promise<WorkerTick> {
  const relay = context.app.get(BrokerRelayService);
  const result = await relay.drain(context.concurrency * 10);
  const automations = context.app.get(AutomationRunnerService);
  ...
}
```

The consequence is the thing this ADR exists to fix. **Automation scheduling ran
nowhere.** An operator could build an automation, activate it, watch
`next_run_at` be computed and a row appear in `automation_schedule_queue` — and
nothing would ever materialize a run, because the only process that drains that
queue cannot boot on an installation with no broker, and is therefore not
deployed. Every screen showed success. Nothing executed.

At the same time, the durable email outbox needed a home. It is background work
that talks to a third party, has no natural HTTP role, and must not run inside a
request.

## Decision

**Separate the two things that were conflated: what a job needs, and what a
process is called.**

1. **`requiresBroker` becomes conditional on configuration, not on the role
   alone.**

   ```ts
   export function requiresBroker(role: ProcessRole, brokerConfigured: boolean): boolean {
     return role === 'worker-integration' && brokerConfigured;
   }
   ```

   "No broker is configured" is a fact about the installation. "A configured
   broker is unreachable" is an outage. The first must not stop a process; the
   second must, and failing closed there is what stops a worker reporting healthy
   while events pile up unsent.

2. **`worker-integration` becomes the outbound third-party integration worker.**
   It drains the email outbox on every tick, unconditionally, and relays to the
   broker when one exists. Its backlog is the signal that a third party is down.
   It is now deployed.

3. **Automation scheduling moves to a new `worker-automation` role**, deployed as
   its own service. It touches no broker, no provider and no external system: it
   reads the contentless schedule queue, writes `automation_runs`, and advances
   each automation's cursor.

4. **Every worker role binds a probe port** serving `/live`, `/ready` and
   `/metrics`. A worker that binds nothing is a worker whose wedged loop is
   indistinguishable from a healthy idle one.

## Alternatives considered

**Bypass the broker check, or bind an in-memory broker.** Rejected outright, and
the reason is in ADR-0004: a queue that quietly becomes an array loses everything
on restart while every dashboard says it is working. Neither option was on the
table.

**Deploy RabbitMQ.** This is the option that looks most "correct" and is the most
expensive mistake available. The broker relay exists to publish domain events to
*external* consumers — a CRM integration that has not been specified, for a
customer whose CRM and field contract have not been supplied. Standing up,
securing, monitoring and paying for a message broker to serve a consumer that
does not exist, in order to unblock a scheduler that does not need one, is
infrastructure bought for a feature nobody has asked to use. The broker remains
the right design for that job, and the day the job exists it will be configured
and `requiresBroker` will start returning true.

**Run automation scheduling inside the API process on a timer.** Rejected. It
puts unbounded background work in the process that must answer an operator in
200 ms, it runs N times over when the API is scaled to N instances, and it makes
a deploy of the API a pause in scheduling.

**Keep scheduling in `worker-integration` and simply deploy that worker.** This
is the smallest change and it would work today. Rejected because it leaves the
coupling in place: the next person who configures a broker, and whose broker then
has a bad afternoon, discovers that a broker outage silently stops every
automation schedule in the installation. The failure would be far harder to find
than the one being fixed here, because at that point the worker *does* boot.

## Consequences

- One more Railway service (`convo-worker-automation`), and one previously
  undeployed service (`convo-worker-integration`) now deployed. Two small
  processes; both are idle most of the time.
- Invitation and password-recovery email now has a worker that runs in
  production. This is the change that makes the email service real rather than
  merely written.
- Automation schedules materialize. The engine still has no *executor* — nothing
  transitions a run from `queued` to `completed` — and that limitation is
  recorded honestly in `docs/audit/PRODUCTION_READINESS_REPORT.md` rather than
  being hidden behind a worker that was never going to run anyway.
- `CONVO_BROKER_URL` becomes the switch that arms the fail-closed check.
