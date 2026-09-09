import type { CapabilityMatrix } from './capabilities.js';
import type { ChannelKind } from './kinds.js';

/**
 * The provider-neutral channel adapter port, version 1.
 *
 * Everything above this line speaks one vocabulary; everything below it knows
 * one provider. The port is versioned so that adding a method is a visible
 * change rather than a silent widening of what every adapter must implement.
 *
 * The methods split into two groups on purpose:
 *
 * - **Pure**: `capabilities`, `verifySignature`, `verifyChallenge`, `normalize`,
 *   `dedupeKey`, `classifyOutcome`. No network, no clock beyond what is passed
 *   in, exhaustively testable against recorded fixtures.
 * - **Transport**: `validateConnection`, `send`, `checkHealth`. These talk to a
 *   provider and are the only part a simulator has to stand in for.
 *
 * Keeping the split explicit is what makes "a simulator is not a live
 * integration" checkable: the pure half is verified for real, and only the
 * transport half is standing in.
 */

export const ADAPTER_PORT_VERSION = 1;

/* ------------------------------------------------------------- signatures -- */

export type SignatureVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: SignatureRefusal };

export const SIGNATURE_REFUSALS = [
  'missing_header',
  'malformed_header',
  'unsupported_algorithm',
  'mismatch',
  'stale',
] as const;

export type SignatureRefusal = (typeof SIGNATURE_REFUSALS)[number];

export interface SignatureInput {
  /** The exact bytes as received. Never a re-serialized object (EVT-01). */
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly secret: string;
  readonly now: Date;
}

/* ------------------------------------------------------- normalized events -- */

export const INBOUND_KINDS = [
  'message',
  'delivery_status',
  'read_status',
  'reaction',
  'identity_change',
  'unsupported',
] as const;

export type InboundKind = (typeof INBOUND_KINDS)[number];

export interface InboundAttachment {
  readonly type: string;
  readonly providerId: string;
  readonly mimeType: string | null;
  readonly caption: string | null;
}

/**
 * One normalized inbound fact.
 *
 * `dedupeKey` is provider- and type-specific and is what makes redelivery safe
 * (DEL-05): the same message in two differently ordered batches produces the
 * same key and therefore one row.
 */
export interface NormalizedEvent {
  readonly kind: InboundKind;
  readonly dedupeKey: string;
  readonly eventType: string;
  /** The provider's identifier for the message this is about, when it has one. */
  readonly providerMessageId: string | null;
  /** The customer's identity as the provider expressed it. */
  readonly peerIdentity: string;
  /** Our asset the event arrived at. */
  readonly assetIdentity: string;
  readonly contentType: string | null;
  readonly text: string | null;
  readonly attachments: readonly InboundAttachment[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  /**
   * The provider's own element this was made from.
   *
   * Carried so the ingress can journal the raw evidence without normalizing
   * twice, and so a later replay can be diffed against what we understood at
   * the time rather than against what the current normalizer would say.
   */
  readonly source: unknown;
}

/**
 * What a batch normalized into.
 *
 * `quarantined` is separate from `events` because a batch with one unsupported
 * element must still deliver the rest (EVT-03, DEL-06). Dropping the batch and
 * dropping the element are both wrong; this shape makes neither possible.
 */
export interface NormalizedBatch {
  readonly assetId: string | null;
  readonly events: readonly NormalizedEvent[];
  readonly quarantined: readonly QuarantinedElement[];
}

export interface QuarantinedElement {
  readonly dedupeKey: string;
  readonly eventType: string;
  readonly reason: string;
  readonly payload: unknown;
}

/* ------------------------------------------------------------- outbound -- */

/**
 * The three-valued send outcome (ADR-0006).
 *
 * `outcome_unknown` is not an error case bolted on: between sending the request
 * and storing the answer there is a window in which we genuinely cannot know,
 * and every product that collapses it into "failed" or "retry" sends duplicate
 * messages to real customers.
 */
export type SendOutcome =
  | { readonly status: 'accepted'; readonly providerMessageId: string; readonly raw: unknown }
  | {
      readonly status: 'definitely_rejected';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly status: 'outcome_unknown'; readonly code: string; readonly message: string };

export interface SendCommand {
  readonly assetIdentity: string;
  readonly peerIdentity: string;
  readonly messageType: string;
  readonly text: string | null;
  readonly template: { readonly name: string; readonly language: string } | null;
  readonly attachments: readonly InboundAttachment[];
  /** Carried to the provider where its contract has actually been verified. */
  readonly idempotencyKey: string;
}

export interface ConnectionCheck {
  readonly ok: boolean;
  readonly assetIdentity: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

/* ------------------------------------------------------------------ port -- */

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly portVersion: number;

  capabilities(): CapabilityMatrix;

  /** HMAC over the exact raw bytes, constant-time, with a replay window. */
  verifySignature(input: SignatureInput): SignatureVerdict;

  /**
   * The GET subscription handshake. Answering it proves we hold the verify
   * token; it authenticates nothing on a POST (ADR-0005).
   */
  verifyChallenge(
    query: Readonly<Record<string, string | undefined>>,
    expectedTokenHash: string,
    hash: (value: string) => string,
  ): string | null;

  /** Provider payload → normalized facts. Pure, and fixture-tested. */
  normalize(payload: unknown, receivedAt: Date): NormalizedBatch;
}

/** The transport half, which a simulator stands in for until assets exist. */
export interface ChannelTransport {
  validateConnection(credential: string, assetIdentity: string): Promise<ConnectionCheck>;
  send(credential: string, command: SendCommand): Promise<SendOutcome>;
}
