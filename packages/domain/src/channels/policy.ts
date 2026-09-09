import { measureText } from './capabilities.js';
import type { CapabilityMatrix } from './capabilities.js';
import type { ChannelKind } from './kinds.js';

/**
 * Whether one specific outbound message may be sent right now.
 *
 * Evaluated at **permit time**, not at draft time (DEL-11): a window that was
 * open when the agent started typing can be shut by the time the worker picks
 * the message up, and the decision that matters is the later one.
 *
 * Every refusal is typed. "Unsupported" is answered here rather than queued to
 * fail at the provider, because a message that can never succeed should never
 * occupy a retry budget or appear as a pending send (CH-01).
 */

export const REFUSAL_REASONS = [
  /** The channel cannot carry this kind of message at all. */
  'not_supported',
  /** The channel could, but this connection or account cannot right now. */
  'not_available',
  /** The reply window has closed. */
  'window_expired',
  /** Outside the window and no approved template was supplied. */
  'template_required',
  /** This channel has no template concept; one was supplied anyway. */
  'template_not_applicable',
  /** The customer has not written first and this channel forbids that. */
  'customer_initiation_required',
  /** The recipient withdrew consent, or is suppressed. */
  'consent_withheld',
  /** Text exceeds the channel's character or byte limit. */
  'text_too_long',
  /** A private note is not an outbound message and never reaches a provider. */
  'note_not_deliverable',
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export type SendPermit =
  | { readonly allowed: true; readonly requiresTemplate: boolean }
  | { readonly allowed: false; readonly reason: RefusalReason; readonly detail: string };

export interface SendRequest {
  readonly kind: ChannelKind;
  /**
   * The matrix this connection was created against, not whatever the current
   * build declares.
   *
   * A connection freezes its capability matrix at connect time (ADR-0009), and
   * the permit has to be decided against the same one — otherwise a version bump
   * silently changes the rules for messages that were drafted under the old one.
   */
  readonly capabilities: CapabilityMatrix;
  readonly messageType: string;
  /** True for an internal note. It must never reach a provider (DEL-11). */
  readonly isPrivateNote: boolean;
  readonly text: string;
  /** When the customer last wrote, or `null` if they never have. */
  readonly lastInboundAt: Date | null;
  readonly now: Date;
  /** A template the caller supplied, with the channel it was approved for. */
  readonly template: { readonly name: string; readonly kind: ChannelKind } | null;
  readonly consentWithdrawn: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export function permitSend(request: SendRequest): SendPermit {
  // Checked first and unconditionally. A note is an internal artefact; no
  // window, template or consent state can make it deliverable, and putting this
  // check anywhere but first would let a future branch reach a provider call.
  if (request.isPrivateNote) {
    return refuse('note_not_deliverable', 'A private note is internal and is never sent.');
  }

  const capabilities = request.capabilities;

  if (!capabilities.outboundTypes.includes(request.messageType)) {
    return refuse(
      'not_supported',
      `${request.kind} cannot send ${request.messageType}.`,
    );
  }

  if (request.template !== null) {
    if (!capabilities.templates) {
      // The rule that stops a WhatsApp template reaching Messenger or
      // Instagram. It is checked before the window, so a caller cannot smuggle
      // one through by also being inside the window.
      return refuse(
        'template_not_applicable',
        `${request.kind} has no template concept; a template was supplied.`,
      );
    }
    if (request.template.kind !== request.kind) {
      return refuse(
        'template_not_applicable',
        `A ${request.template.kind} template cannot be used on ${request.kind}.`,
      );
    }
  }

  if (request.consentWithdrawn) {
    // After the shape checks and before the window: withdrawn consent refuses a
    // send that would otherwise be perfectly legal, and it is never fail-open.
    return refuse('consent_withheld', 'The recipient has withdrawn consent.');
  }

  const measurement = measureText(request.text, capabilities.textLimit);
  if (!measurement.withinLimit) {
    return refuse(
      'text_too_long',
      `${String(measurement.characters)} characters / ${String(measurement.bytes)} bytes exceeds ` +
        `${String(capabilities.textLimit.characters)} / ${String(capabilities.textLimit.bytes)}.`,
    );
  }

  if (capabilities.windowHours === null) {
    return { allowed: true, requiresTemplate: false };
  }

  const openUntil =
    request.lastInboundAt === null
      ? null
      : new Date(request.lastInboundAt.getTime() + capabilities.windowHours * HOUR_MS);
  const withinWindow = openUntil !== null && request.now < openUntil;

  if (withinWindow) {
    return { allowed: true, requiresTemplate: false };
  }

  if (!capabilities.businessInitiated) {
    // Instagram and Messenger: outside the window there is no template path,
    // so this is the end of the road rather than a "supply a template" hint.
    return refuse(
      request.lastInboundAt === null ? 'customer_initiation_required' : 'window_expired',
      request.lastInboundAt === null
        ? `${request.kind} conversations must be started by the customer.`
        : `The ${String(capabilities.windowHours)}-hour reply window has closed.`,
    );
  }

  if (!capabilities.templates) {
    return refuse('window_expired', `The ${String(capabilities.windowHours)}-hour window has closed.`);
  }

  if (request.template === null) {
    return refuse(
      'template_required',
      `Outside the ${String(capabilities.windowHours)}-hour window, an approved template is required.`,
    );
  }

  return { allowed: true, requiresTemplate: true };
}

function refuse(reason: RefusalReason, detail: string): SendPermit {
  return { allowed: false, reason, detail };
}
