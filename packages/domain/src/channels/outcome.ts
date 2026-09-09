import type { SendOutcome } from './port.js';

/**
 * Classifying what happened to an outbound request (ADR-0006, DEL-13).
 *
 * The rule this exists to enforce: **"an exception occurred" is not a
 * classification**. A 400 from a provider and a socket closing mid-response are
 * both exceptions to a naive `try`/`catch`, and they are opposites — the first
 * definitely did not send, the second may well have. Treating them the same
 * either loses messages or duplicates them to real customers.
 *
 * So the classifier is explicit, per provider, and unit-tested. It answers one
 * of exactly three things:
 *
 * - **`accepted`** — the provider gave us an id. It is on their side now.
 * - **`definitely_rejected`** — the provider answered, and the answer was no.
 *   Nothing was sent; retrying is safe if the reason is transient.
 * - **`outcome_unknown`** — we never learned. It may have sent. Nothing may
 *   resend it automatically, ever.
 */

/** What a transport observed, before it is classified. */
export type TransportObservation =
  | { readonly kind: 'response'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'transport_error'; readonly code: string; readonly message: string };

/**
 * Network-level failures whose timing tells us whether the request was sent.
 *
 * A refused connection and an unresolvable host happen *before* any bytes leave,
 * so nothing was sent and the message can be retried safely. A timeout or a
 * reset happens after the request is on the wire, and the provider may have
 * processed it — that is the ambiguous case the whole state exists for.
 */
const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'DNS_FAILURE',
  'TLS_HANDSHAKE_FAILED',
]);

/**
 * Provider status codes that are worth trying again.
 *
 * A 429 or a 5xx says "not now", not "never". A 4xx other than 429 says the
 * request itself is wrong, and retrying an identical wrong request wastes a
 * budget and a rate limit to get the same answer.
 */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface ClassifierInput {
  readonly observation: TransportObservation;
  /**
   * The provider's id for the message, when the response carried one. Passed in
   * rather than dug out here, because where it lives differs per provider and
   * that is the adapter's business.
   */
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export function classifyOutcome(input: ClassifierInput): SendOutcome {
  const observation = input.observation;

  if (observation.kind === 'transport_error') {
    if (NEVER_SENT_CODES.has(observation.code)) {
      return {
        status: 'definitely_rejected',
        code: observation.code,
        message: observation.message,
        retryable: true,
      };
    }
    // A timeout, a reset, an aborted read: the request was on the wire and the
    // answer never came back. This is the case that must never be resent.
    return { status: 'outcome_unknown', code: observation.code, message: observation.message };
  }

  if (observation.status >= 200 && observation.status < 300) {
    if (input.providerMessageId === null) {
      // A 2xx with nothing to identify the message by. We cannot prove it was
      // accepted and we cannot prove it was not, and a message we can never
      // correlate a receipt to is exactly an unknown outcome.
      return {
        status: 'outcome_unknown',
        code: 'no_provider_message_id',
        message: 'The provider accepted the request without returning a message id.',
      };
    }
    return { status: 'accepted', providerMessageId: input.providerMessageId, raw: observation.body };
  }

  return {
    status: 'definitely_rejected',
    code: input.errorCode ?? `http_${String(observation.status)}`,
    message: input.errorMessage ?? 'The provider rejected the request.',
    retryable: retryableStatus(observation.status),
  };
}

/* --------------------------------------------------------- state machines -- */

/**
 * What we asked for. Nine states, from ADR-0006, and none of them ordered:
 * this is not a progress bar and there is no `max()` over it.
 */
export const COMMAND_STATES = [
  'queued',
  'dispatching',
  'provider_accepted',
  'rejected',
  'retry_scheduled',
  'skipped',
  'cancelled',
  'failed',
  'outcome_unknown',
] as const;

export type CommandState = (typeof COMMAND_STATES)[number];

/** What the provider says happened. Separate, and folded separately. */
export const DELIVERY_STATES = ['sent', 'delivered', 'read'] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** How far along each delivery state is, for the fold below only. */
const DELIVERY_RANK: Readonly<Record<DeliveryState, number>> = { sent: 1, delivered: 2, read: 3 };

export interface DeliveryFold {
  readonly state: DeliveryState;
  readonly at: Date;
  /** Set when the receipt disagreed with what we already knew. */
  readonly anomaly: string | null;
}

/**
 * Folds one provider receipt into what we already believe.
 *
 * Receipts arrive out of order, and the naive fixes are both wrong: taking the
 * latest by timestamp lets a delayed `sent` erase a `read`, and taking the
 * maximum rank silently invents an ordering the provider never claimed.
 *
 * The rule here is that **a receipt never moves the state backwards**, and a
 * receipt that would have is recorded as an anomaly rather than discarded. The
 * timeline stays at `read`; the fact that `delivered` arrived afterwards is
 * kept, because it is evidence about the provider, not noise (EVT-04, DEL-16).
 */
export function foldDelivery(
  current: DeliveryFold | null,
  incoming: { readonly state: DeliveryState; readonly at: Date },
): DeliveryFold {
  if (current === null) {
    return { state: incoming.state, at: incoming.at, anomaly: null };
  }
  if (DELIVERY_RANK[incoming.state] > DELIVERY_RANK[current.state]) {
    return { state: incoming.state, at: incoming.at, anomaly: current.anomaly };
  }
  if (incoming.state === current.state) {
    // A redelivered receipt for a state we already hold. Not an anomaly: the
    // provider is allowed to say the same thing twice.
    return current;
  }
  return {
    state: current.state,
    at: current.at,
    anomaly: `${incoming.state}_after_${current.state}`,
  };
}

/**
 * Whether an `outcome_unknown` message may be retried automatically.
 *
 * Always false. It is a function rather than a constant so the call site reads
 * as a decision, and so the three ways an unknown outcome may legitimately be
 * resolved — a verified provider idempotency contract, a reliable lookup, or a
 * human decision recorded as a controlled manual retry — have one obvious place
 * to be added when any of them is actually implemented and verified.
 */
export function mayAutoRetry(state: CommandState): boolean {
  return state === 'retry_scheduled' || state === 'queued';
}
