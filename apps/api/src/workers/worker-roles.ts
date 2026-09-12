import type { INestApplicationContext } from '@nestjs/common';
import { DEFAULT_INTERACTIVE_RESERVATION, planRound } from '@convo/domain';
import { BrokerRelayService } from '../broker/relay.service.js';
import type { ProcessRole } from '../config.js';
import { ChannelDispatcherService } from '../channels/dispatcher.service.js';
import { ChannelNormalizationService } from '../channels/normalization.service.js';
import { LifecycleService } from '../conversations/lifecycle.service.js';
import { RoutingService } from '../conversations/routing.service.js';
import { CampaignPlannerService } from '../campaigns/campaign-planner.service.js';
import type { WorkerTick } from './worker-loop.js';

/**
 * What each worker role actually does per tick.
 *
 * One artifact, six jobs. They are separate roles rather than flags on one
 * process because their failure modes and their appetite for resources are
 * genuinely different: an ingress that must answer in 200 ms should not share a
 * connection pool with a campaign worker draining a million recipients
 * (ADR-0005, ADR-0007).
 *
 * Each tick is written to be **restart-safe and idempotent**. A worker that dies
 * mid-tick leaves its claims to expire, and the work is picked up again with no
 * duplicate effect — every claim is a lease and every effect is keyed.
 */

export type WorkerRole = Exclude<ProcessRole, 'api' | 'ingress' | 'realtime'>;

export interface WorkerContext {
  readonly app: INestApplicationContext;
  readonly concurrency: number;
}

export function tickFor(role: WorkerRole, context: WorkerContext): () => Promise<WorkerTick> {
  if (role === 'worker-inbound') {
    return () => inboundTick(context);
  }
  if (role === 'worker-interactive') {
    return () => outboundTick(context, 'interactive');
  }
  if (role === 'worker-campaign') {
    return () => outboundTick(context, 'bulk');
  }
  return () => integrationTick(context);
}

/**
 * Journalled provider events become normalized inbound events.
 *
 * Everything the webhook ACK deliberately does not do (DEL-04).
 */
async function inboundTick(context: WorkerContext): Promise<WorkerTick> {
  const normalizer = context.app.get(ChannelNormalizationService);
  const dispatcher = context.app.get(ChannelDispatcherService);
  const lifecycle = context.app.get(LifecycleService);
  const routing = context.app.get(RoutingService);
  const tenants = await normalizer.pendingTenants();
  // A snooze that is due is work whether or not anything else arrived. Its
  // company list comes from the wake queue rather than from this tick's
  // tenants, for exactly the reason receipts are folded here: a company with a
  // quiet inbox would otherwise never have its conversations woken.
  let handled = await lifecycle.sweepDueWakes(new Date(), context.concurrency * 10);
  handled += await routing.sweepExpiredHandoffs(new Date(), context.concurrency * 10);
  for (const tenantId of tenants) {
    const result = await normalizer.drain(tenantId, context.concurrency * 10);
    handled += result.claimed;
    // A delivery receipt is an inbound event like any other, and folding it onto
    // the message it belongs to is that event's effect. It happens here rather
    // than on the outbound tick because the outbound tick only visits companies
    // with something to *send*: a company whose queue is empty would otherwise
    // never see its delivery ticks arrive.
    handled += await dispatcher.reconcileReceipts(tenantId);
  }
  return { handled };
}

/**
 * Outbound dispatch for one traffic class, through the fair scheduler.
 *
 * Two roles run this — interactive and campaign — against the same outbox with
 * different classes and different pools. Separating the *processes* is what
 * keeps a million-recipient campaign from consuming the workers a customer
 * reply needs; separating the *companies within a round* is what keeps one
 * loud company from consuming the rest (ADR-0007).
 *
 * The round is bounded on purpose. Before this, every pending company was given
 * up to `concurrency` messages per tick, so a tick's size was a function of how
 * many companies happened to be busy — a queue with no ceiling, which is the
 * thing that eventually takes the database with it. Now the round has a
 * capacity, `planRound` deals it out one slot at a time, and what was offered
 * and what was achieved are both reported.
 *
 * Recovery runs first and is deliberately **not** a retry: it finds attempts
 * that were started and never answered and marks them `outcome_unknown`.
 * Nothing it does puts a message back on the wire.
 */
async function outboundTick(
  context: WorkerContext,
  trafficClass: 'interactive' | 'bulk',
): Promise<WorkerTick> {
  const dispatcher = context.app.get(ChannelDispatcherService);
  let planned = 0;
  if (trafficClass === 'bulk') {
    const planner = context.app.get(CampaignPlannerService);
    for (const tenantId of await planner.pendingTenants()) {
      planned += await planner.plan(tenantId, context.concurrency * ROUND_MULTIPLIER);
    }
  }
  const offers = await dispatcher.offers(trafficClass);
  const plan = planRound(offers, {
    // The whole round, not per company: capacity is what this process can
    // safely have in flight, and the plan decides who gets it.
    capacity: context.concurrency * ROUND_MULTIPLIER,
    interactiveReservation: DEFAULT_INTERACTIVE_RESERVATION,
  });

  let handled = planned;
  for (const grant of plan.grants) {
    await dispatcher.recoverOrphanedAttempts(grant.tenantId);
    const result = await dispatcher.dispatch(
      grant.tenantId,
      grant.granted,
      `${trafficClass}-worker`,
      trafficClass,
    );
    handled += result.claimed;
  }
  return {
    handled,
    // Offered and achieved, side by side. A fairness number nobody can see is
    // a fairness number nobody can check.
    fairness: { offered: plan.offered[trafficClass], achieved: plan.achieved[trafficClass] },
  };
}

/**
 * How many messages one unit of configured concurrency may claim in a round.
 *
 * A round larger than the pool would queue work inside the process instead of
 * leaving it in the database, which is where it is durable.
 */
const ROUND_MULTIPLIER = 4;

/**
 * The relay to the durable broker.
 *
 * Its own role because it is the one worker whose health is about a dependency
 * rather than about the database: when the broker is unreachable this is the
 * process whose backlog grows, and seeing that is how an operator learns the
 * broker is down before anybody notices missing events.
 */
async function integrationTick(context: WorkerContext): Promise<WorkerTick> {
  const relay = context.app.get(BrokerRelayService);
  const result = await relay.drain(context.concurrency * 10);
  return { handled: result.claimed };
}
