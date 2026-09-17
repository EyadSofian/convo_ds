# Runbook: automation engine

## Runtime

`convo-worker-automation` is the only scheduled executor. Each tick discovers
tenants with due schedule or work rows, materializes schedules idempotently,
then claims a bounded tenant transaction. Runs are frozen snapshots; recipients
and ordered action executions are durable PostgreSQL rows protected by forced
tenant RLS.

## Supported production actions

- delay (1 second through 365 days)
- approved WhatsApp template enqueue through the shared outbox
- add/remove contact label
- update contact custom field
- an empty condition step as a pass-through

Targets currently supported by the executor are an event/configured
`contactId`/`customerId` and a live label audience. Other targets and action
types fail the run with a typed, visible error; they never report success.

## Diagnosis

1. Check `/ready` and `/metrics` on `convo-worker-automation` over the private
   network. `last_tick_at` must advance.
2. Inspect `automation_work_queue`, then the run, recipients, and
   `automation_action_executions` under the affected tenant context.
3. A waiting delay has a future `available_at`. Do not rewrite it unless an
   incident commander has established that the source clock/configuration was
   wrong.
4. For WhatsApp, inspect the linked `outbound_messages` and outbox row. Delivery
   evidence is reconciled back into the recipient on later worker ticks.
5. Never delete a failed run to retry it. Correct the automation/configuration
   and trigger a new idempotency key so both attempts remain auditable.

## Restart and rollback

An interrupted transaction rolls back the action claim and side effect
together. Outbound client ids are deterministic per recipient and step, so a
restart cannot enqueue a second provider command. Roll back application code by
redeploying the prior image; migration `0032` is additive and remains in place.
