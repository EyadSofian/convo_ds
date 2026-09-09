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
 * The Facebook Messenger Page-messaging adapter.
 *
 * Separate from WhatsApp in every way that matters: page-scoped identities
 * rather than phone numbers, `pages_messaging` rather than a WABA grant, no
 * template concept at all, and an eligible-message window this channel enforces
 * on its own terms (CH-MSG-01, CH-MSG-02).
 *
 * The one thing it shares with the other Meta channels is the wire: one app,
 * one signature scheme, one envelope skeleton. Everything a *policy* could be
 * built from is declared per channel.
 */
export class MessengerAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'messenger';
  readonly portVersion = ADAPTER_PORT_VERSION;

  constructor(private readonly crypto: ChannelCrypto) {}

  capabilities(): CapabilityMatrix {
    return capabilitiesFor('messenger');
  }

  /** Whether a verified delivery is this channel's. Meta multiplexes them. */
  claims(payload: unknown): boolean {
    return asRecord(payload)?.['object'] === 'page';
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
      kind: 'messenger',
      envelopeObject: 'page',
      keyPrefix: 'mg',
      extra: (item, context) => postbackOf(item, context),
    });
  }
}

/**
 * A postback: the customer tapped a button we sent rather than typing.
 *
 * Messenger's, not Instagram's — Instagram's button semantics differ and are
 * declared in that adapter. It is normalized as a message with the button's
 * title as the text, because that is what an agent needs to read, with the
 * machine payload kept in `detail` for anything that routes on it.
 */
function postbackOf(
  item: Record<string, unknown>,
  context: MessagingContext,
): NormalizedEvent | null {
  const postback = asRecord(item['postback']);
  if (postback === null) {
    return null;
  }
  const mid = asString(postback['mid']);
  const title = asString(postback['title']);
  const payload = asString(postback['payload']);
  if (mid === null && payload === null) {
    return null;
  }
  return {
    kind: 'message',
    // A postback with no mid is keyed on its payload and the moment it landed,
    // which is the only stable pair Messenger offers for one.
    dedupeKey: `${context.keyPrefix}:postback:${mid ?? `${context.senderId}:${String(context.occurredAt.getTime())}`}`,
    eventType: 'messaging.postback',
    providerMessageId: mid,
    peerIdentity: context.senderId,
    assetIdentity: context.assetId,
    contentType: 'postback',
    text: title,
    attachments: [],
    detail: { payload },
    occurredAt: context.occurredAt,
    source: item,
  };
}
