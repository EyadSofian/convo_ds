import { capabilitiesFor, type CapabilityMatrix } from './capabilities.js';
import type { ChannelCrypto } from './crypto.js';
import type { ChannelKind } from './kinds.js';
import { answerMetaChallenge, verifyMetaSignature } from './meta-signature.js';
import { asRecord, asString, normalizeMetaMessaging } from './meta-messaging.js';
import type { MessagingContext } from './meta-messaging.js';
import type {
  ChannelAdapter,
  NormalizedBatch,
  NormalizedEvent,
  SignatureInput,
  SignatureVerdict,
} from './port.js';
import { ADAPTER_PORT_VERSION } from './port.js';

/**
 * The Instagram professional-messaging adapter.
 *
 * A separate adapter configuration from Messenger, not a flag on it (CH-IG-01,
 * CH-IG-02). The differences are not cosmetic:
 *
 * - its own host, `graph.instagram.com`, declared in its capability matrix;
 * - conversations are **customer-initiated**, so a cold DM is refused with a
 *   typed reason rather than queued to fail (CH-IG-03);
 * - no template concept at all, so a WhatsApp template cannot be smuggled in;
 * - reactions are a first-class inbound event here and are not one on
 *   Messenger.
 *
 * The Facebook Login path for Instagram is a *third* configuration with its own
 * scopes and evidence; it is not implemented, and pretending this adapter
 * covers it would be exactly the conflation ADR-0009 forbids.
 */
export class InstagramAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'instagram';
  readonly portVersion = ADAPTER_PORT_VERSION;

  constructor(private readonly crypto: ChannelCrypto) {}

  capabilities(): CapabilityMatrix {
    return capabilitiesFor('instagram');
  }

  claims(payload: unknown): boolean {
    return asRecord(payload)?.['object'] === 'instagram';
  }

  verifySignature(input: SignatureInput): SignatureVerdict {
    return verifyMetaSignature(input, this.crypto);
  }

  verifyChallenge(
    query: Readonly<Record<string, string | undefined>>,
    expectedTokenHash: string,
  ): string | null {
    return answerMetaChallenge(query, expectedTokenHash, this.crypto);
  }

  normalize(payload: unknown, receivedAt: Date): NormalizedBatch {
    return normalizeMetaMessaging(payload, receivedAt, this.crypto, {
      kind: 'instagram',
      envelopeObject: 'instagram',
      keyPrefix: 'ig',
      extra: (item, context) => reactionOf(item, context),
    });
  }
}

/**
 * A reaction on a message we sent.
 *
 * Its own kind rather than a message, because it is not something to reply to
 * and showing it as an inbound message would put a heart in the transcript as
 * if the customer had typed one. Removing a reaction arrives as the same event
 * with `action: "unreact"`, and both are kept: which one is current is a fold,
 * not a filter.
 */
function reactionOf(
  item: Record<string, unknown>,
  context: MessagingContext,
): NormalizedEvent | null {
  const reaction = asRecord(item['reaction']);
  if (reaction === null) {
    return null;
  }
  const mid = asString(reaction['mid']);
  if (mid === null) {
    return null;
  }
  const action = asString(reaction['action']) ?? 'react';
  return {
    kind: 'reaction',
    // Keyed by action as well as message: reacting and un-reacting to the same
    // message are two facts, and one key would make the second look duplicate.
    dedupeKey: `${context.keyPrefix}:reaction:${mid}:${action}:${context.senderId}`,
    eventType: `messaging.reaction.${action}`,
    providerMessageId: mid,
    peerIdentity: context.senderId,
    assetIdentity: context.assetId,
    contentType: 'reaction',
    text: asString(reaction['emoji']),
    attachments: [],
    detail: { action, reaction: asString(reaction['reaction']) },
    occurredAt: context.occurredAt,
    source: item,
  };
}
