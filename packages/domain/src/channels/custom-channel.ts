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
 * The Custom Channel API — a published, versioned contract for a transport we
 * do not write.
 *
 * An operator with an SMS gateway, a kiosk or an in-house app implements this
 * and gets an inbox for it. Because they implement it, three things have to be
 * explicit rather than assumed:
 *
 * 1. **The version is in the payload.** `version` is required and checked. An
 *    integration written against v1 keeps working when v2 exists, and a
 *    delivery from a version this build does not know is quarantined with its
 *    payload rather than parsed hopefully.
 * 2. **Capabilities are negotiated, not assumed.** The connection declares what
 *    its transport can carry, and the capability matrix is the ceiling. An
 *    event type outside the contract is stored and shown as a fallback.
 * 3. **The signature is the same discipline as everywhere else.** HMAC over the
 *    exact raw bytes with a timestamp inside the signed material, because a
 *    contract that says "send us your tenant id" is not a contract, it is an
 *    open door.
 */
export const CUSTOM_CHANNEL_VERSIONS = ['1'] as const;
export const CUSTOM_SIGNATURE_HEADER = 'x-convo-signature';
export const CUSTOM_TIMESTAMP_HEADER = 'x-convo-timestamp';
export const CUSTOM_REPLAY_WINDOW_SECONDS = 300;

/** The event types version 1 of the contract defines. */
export const CUSTOM_EVENT_TYPES = ['message', 'delivery_status', 'read_status'] as const;

export class CustomChannelAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'custom';
  readonly portVersion = ADAPTER_PORT_VERSION;

  constructor(private readonly crypto: ChannelCrypto) {}

  capabilities(): CapabilityMatrix {
    return capabilitiesFor('custom');
  }

  claims(payload: unknown): boolean {
    return asRecord(payload)?.['object'] === 'convo_custom';
  }

  verifySignature(input: SignatureInput): SignatureVerdict {
    const header = input.headers[CUSTOM_SIGNATURE_HEADER];
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
    const timestamp = input.headers[CUSTOM_TIMESTAMP_HEADER];
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
    return age > CUSTOM_REPLAY_WINDOW_SECONDS ? { valid: false, reason: 'stale' } : { valid: true };
  }

  /** No handshake: the operator configures both ends themselves. */
  verifyChallenge(): string | null {
    return null;
  }

  normalize(payload: unknown, receivedAt: Date): NormalizedBatch {
    const root = asRecord(payload);
    if (root === null || root['object'] !== 'convo_custom') {
      return {
        assetId: null,
        events: [],
        quarantined: [quarantine(this.crypto, 'cc', payload, 'unknown', 'not_a_custom_envelope')],
      };
    }

    const version = asString(root['version']);
    if (version === null || !(CUSTOM_CHANNEL_VERSIONS as readonly string[]).includes(version)) {
      // Not parsed hopefully: a payload from a version we do not implement is
      // kept whole so it can be replayed once support exists.
      return {
        assetId: asString(root['asset_id']),
        events: [],
        quarantined: [
          quarantine(this.crypto, 'cc', payload, 'unknown', `unsupported_contract_version:${version ?? 'absent'}`),
        ],
      };
    }

    const assetId = asString(root['asset_id']);
    const events: NormalizedEvent[] = [];
    const quarantined: QuarantinedElement[] = [];

    for (const raw of asArray(root['events'])) {
      const event = asRecord(raw);
      const id = asString(event?.['id']);
      const from = asString(event?.['from']);
      const type = asString(event?.['type']);
      if (event === null || id === null || from === null || type === null) {
        quarantined.push(quarantine(this.crypto, 'cc', raw, 'events', 'event_missing_fields'));
        continue;
      }
      if (!(CUSTOM_EVENT_TYPES as readonly string[]).includes(type)) {
        quarantined.push(
          quarantine(this.crypto, 'cc', event, `custom.${type}`, 'unsupported_event_type'),
        );
        continue;
      }
      const occurredAt = isoOf(event['occurred_at'], receivedAt);

      if (type === 'message') {
        const text = asString(event['text']);
        // The operator's system usually knows who is writing; their name lets
        // the contact read as a person rather than as an id.
        const name = (asString(event['name']) ?? asString(asRecord(event['sender'])?.['name']) ?? '').trim().slice(0, 200);
        const detail: Record<string, unknown> = text === null ? { unsupported_message: true } : {};
        if (name !== '') detail['sender_name'] = name;
        events.push({
          kind: text === null ? 'unsupported' : 'message',
          dedupeKey: `cc:msg:${id}`,
          eventType: 'custom.message',
          providerMessageId: id,
          peerIdentity: from,
          assetIdentity: assetId ?? '',
          contentType: asString(event['content_type']) ?? 'text',
          text,
          attachments: [],
          detail,
          occurredAt,
          source: event,
        });
        continue;
      }

      // A status about a message the operator's transport sent for us.
      events.push({
        kind: type === 'read_status' ? 'read_status' : 'delivery_status',
        dedupeKey: `cc:status:${id}:${type}`,
        eventType: `custom.${type}`,
        providerMessageId: asString(event['message_id']) ?? id,
        peerIdentity: from,
        assetIdentity: assetId ?? '',
        contentType: null,
        text: null,
        attachments: [],
        detail: { reported_type: type },
        occurredAt,
        source: event,
      });
    }

    return { assetId, events, quarantined };
  }
}

/**
 * Whether the connection's declared capabilities admit an outbound type.
 *
 * Capability negotiation, from the operator's side: the matrix is the ceiling
 * and the declaration narrows it. Declaring something the matrix does not have
 * widens nothing — the intersection is what is offered.
 */
export function negotiateCustomTypes(
  declared: readonly string[],
  matrix: CapabilityMatrix,
): readonly string[] {
  return matrix.outboundTypes.filter((type) => declared.includes(type));
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
