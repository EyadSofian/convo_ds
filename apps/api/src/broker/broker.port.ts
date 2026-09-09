/**
 * The durable-broker port.
 *
 * ADR-0004 makes the broker a transport rather than a source of truth, and this
 * interface is where that shows: publishing is the only thing it does, it
 * reports whether the broker **confirmed** the publish, and it has no read side
 * — a consumer's position lives in PostgreSQL, not in the broker.
 *
 * There is deliberately **no in-memory implementation for production**. A
 * process configured to require a broker fails closed when it cannot reach one:
 * a queue that quietly becomes an array is a queue that loses everything on
 * restart while every dashboard says it is working.
 */

export interface BrokerEnvelope {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: string;
  /** Ids and routing shape. Never a message body (ADR-0007). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * What the broker said about one publish.
 *
 * Three outcomes, for the same reason the send path has three: a confirmed
 * publish, a refusal, and "we do not know" — a connection that dropped between
 * the publish and the confirmation may or may not have delivered it. Unknown is
 * retried here, unlike an outbound message to a customer, because a duplicate
 * event is absorbed by consumer idempotency and a lost event is not recoverable.
 */
export type PublishOutcome =
  | { readonly status: 'confirmed' }
  | { readonly status: 'refused'; readonly code: string; readonly message: string }
  | { readonly status: 'unknown'; readonly code: string; readonly message: string };

export interface BrokerPort {
  readonly name: string;
  /** Whether a broker is actually reachable right now. */
  healthy(): Promise<boolean>;
  /** Publishes one envelope and waits for the broker's confirmation. */
  publish(envelope: BrokerEnvelope): Promise<PublishOutcome>;
}

export const BROKER_UNAVAILABLE_CODE = 'broker_not_configured';

/**
 * The default: no broker.
 *
 * It refuses rather than pretending, and it refuses with `unknown` rather than
 * `refused` for exactly one reason — a `refused` publish is a permanent
 * rejection of that envelope, and "nobody configured a broker" is a temporary
 * fact about the installation, not a fact about the message. The relay
 * therefore retries and the outbox grows visibly, which is the correct
 * behaviour for a transport that is missing.
 */
export const unconfiguredBroker: BrokerPort = {
  name: 'unconfigured',
  healthy: () => Promise.resolve(false),
  publish: () =>
    Promise.resolve({
      status: 'unknown',
      code: BROKER_UNAVAILABLE_CODE,
      message: 'No durable broker is configured for this installation.',
    }),
};
