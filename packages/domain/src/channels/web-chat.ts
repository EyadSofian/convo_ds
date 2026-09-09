import { capabilitiesFor, type CapabilityMatrix } from './capabilities.js';
import type { ChannelCrypto } from './crypto.js';
import type { ChannelKind } from './kinds.js';
import { asArray, asRecord, asString, quarantine } from './meta-messaging.js';
import type {
  ChannelAdapter,
  NormalizedBatch,
  NormalizedEvent,
  QuarantinedElement,
  SignatureInput,
  SignatureVerdict,
} from './port.js';
import { ADAPTER_PORT_VERSION } from './port.js';

/**
 * The website live-chat widget.
 *
 * Our own channel, and the only one where we write both ends. That changes what
 * the security boundary is made of: there is no provider signing our
 * deliveries, so the *installation* signs them with a key we issued, and the
 * verification is the same HMAC-over-raw-bytes discipline the Meta channels
 * use — a widget is a client, and a client is not trusted because it says which
 * company it belongs to.
 *
 * Three things this channel enforces that the provider channels get for free:
 *
 * - **Origin allowlist.** A signing key that leaked into a page's source can be
 *   used from anywhere; requiring the delivery to come from a declared origin
 *   bounds that. It is a second lock, not the only one.
 * - **Rate limit.** A widget is reachable by anyone who loads the page, so the
 *   ingress caps how fast one installation may deliver.
 * - **Session continuity.** A visitor has no account. The session id is the
 *   identity, and it is opaque, per-installation and supplied by us.
 */
export const WEB_CHAT_SIGNATURE_HEADER = 'x-convo-signature';
export const WEB_CHAT_TIMESTAMP_HEADER = 'x-convo-timestamp';
/** Deliveries older than this are refused even with a valid signature. */
export const WEB_CHAT_REPLAY_WINDOW_SECONDS = 300;

export class WebChatAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'web_chat';
  readonly portVersion = ADAPTER_PORT_VERSION;

  constructor(private readonly crypto: ChannelCrypto) {}

  capabilities(): CapabilityMatrix {
    return capabilitiesFor('web_chat');
  }

  claims(payload: unknown): boolean {
    return asRecord(payload)?.['object'] === 'web_chat';
  }

  /**
   * `v1=<hex>` over `<timestamp>.<raw body>`.
   *
   * The timestamp is inside the signed material rather than beside it, so it
   * cannot be rewritten to make an old capture look fresh. Unlike Meta, an
   * undated delivery is refused outright: this is our own client and we decide
   * what it sends, so there is no legitimate sender that omits it.
   */
  verifySignature(input: SignatureInput): SignatureVerdict {
    const header = input.headers[WEB_CHAT_SIGNATURE_HEADER];
    if (header === undefined || header === '') {
      return { valid: false, reason: 'missing_header' };
    }
    if (!header.startsWith('v1=')) {
      return { valid: false, reason: 'unsupported_algorithm' };
    }
    const provided = header.slice(3).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(provided)) {
      return { valid: false, reason: 'malformed_header' };
    }
    const timestamp = input.headers[WEB_CHAT_TIMESTAMP_HEADER];
    if (timestamp === undefined || !/^\d{1,20}$/.test(timestamp)) {
      return { valid: false, reason: 'malformed_header' };
    }

    const signed = new TextEncoder().encode(
      `${timestamp}.${new TextDecoder().decode(input.rawBody)}`,
    );
    if (!this.crypto.timingSafeEqualHex(this.crypto.hmacSha256Hex(input.secret, signed), provided)) {
      return { valid: false, reason: 'mismatch' };
    }
    const age = Math.abs(input.now.getTime() / 1000 - Number(timestamp));
    return age > WEB_CHAT_REPLAY_WINDOW_SECONDS
      ? { valid: false, reason: 'stale' }
      : { valid: true };
  }

  /**
   * There is no subscription handshake: we install the widget ourselves.
   *
   * Answering `null` rather than throwing keeps the port total — every adapter
   * answers the same question, and this one's honest answer is "not applicable".
   */
  verifyChallenge(): string | null {
    return null;
  }

  normalize(payload: unknown, receivedAt: Date): NormalizedBatch {
    const root = asRecord(payload);
    if (root === null || root['object'] !== 'web_chat') {
      return {
        assetId: null,
        events: [],
        quarantined: [
          quarantine(this.crypto, 'wc', payload, 'unknown', 'not_a_web_chat_envelope'),
        ],
      };
    }
    const assetId = asString(root['installation_id']);
    const events: NormalizedEvent[] = [];
    const quarantined: QuarantinedElement[] = [];

    for (const raw of asArray(root['events'])) {
      const event = asRecord(raw);
      const id = asString(event?.['id']);
      const session = asString(event?.['session_id']);
      const type = asString(event?.['type']);
      if (event === null || id === null || session === null || type === null) {
        quarantined.push(quarantine(this.crypto, 'wc', raw, 'events', 'event_missing_fields'));
        continue;
      }
      const occurredAt = isoOf(event['occurred_at'], receivedAt);

      if (type === 'message') {
        const text = asString(event['text']);
        events.push({
          kind: text === null ? 'unsupported' : 'message',
          dedupeKey: `wc:msg:${id}`,
          eventType: 'web_chat.message',
          providerMessageId: id,
          // The session *is* the identity: a visitor has no account, and the id
          // is opaque and issued by us rather than chosen by the page.
          peerIdentity: session,
          assetIdentity: assetId ?? '',
          contentType: 'text',
          text,
          attachments: [],
          detail: text === null ? { unsupported_message: true } : {},
          occurredAt,
          source: event,
        });
        continue;
      }

      if (type === 'session_start') {
        events.push({
          kind: 'identity_change',
          dedupeKey: `wc:session:${id}`,
          eventType: 'web_chat.session_start',
          providerMessageId: null,
          peerIdentity: session,
          assetIdentity: assetId ?? '',
          contentType: null,
          text: null,
          attachments: [],
          detail: { page: asString(event['page_url']), locale: asString(event['locale']) },
          occurredAt,
          source: event,
        });
        continue;
      }

      // `typing` and anything else a future widget sends: kept with its payload
      // so it can be rendered as a documented fallback rather than vanishing.
      quarantined.push(quarantine(this.crypto, 'wc', event, `web_chat.${type}`, 'unsupported_event_type'));
    }

    return { assetId, events, quarantined };
  }
}

/**
 * Whether a delivery's origin is one this installation declared.
 *
 * Exact match on scheme, host and port, not a suffix test: a `endsWith`
 * comparison on `example.com` also matches `evil-example.com`, which is the
 * classic way an allowlist becomes decoration.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) {
    // An installation that declared no origins is not "open to everything"; it
    // is not finished being configured, and the honest reading is no.
    return false;
  }
  return origin !== undefined && allowed.includes(origin);
}

function isoOf(value: unknown, fallback: Date): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}
