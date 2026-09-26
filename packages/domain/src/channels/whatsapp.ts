import { capabilitiesFor, type CapabilityMatrix } from './capabilities.js';
import type { ChannelCrypto } from './crypto.js';
import type { ChannelKind } from './kinds.js';
import { answerMetaChallenge, verifyMetaSignature } from './meta-signature.js';
import type {
  ChannelAdapter,
  InboundAttachment,
  NormalizedBatch,
  NormalizedEvent,
  QuarantinedElement,
  SignatureInput,
  SignatureVerdict,
} from './port.js';
import { ADAPTER_PORT_VERSION } from './port.js';

/**
 * The WhatsApp Cloud API adapter — the pure half.
 *
 * Normalization is where a provider's shape stops. Everything downstream sees
 * `NormalizedEvent`, so nothing else in the product has to know that WhatsApp
 * puts the recipient's phone number id under
 * `entry[].changes[].value.metadata.phone_number_id`, or that a status update
 * arrives in the same webhook as a message.
 *
 * Three rules the normalizer follows, each of which is a requirement:
 *
 * - **A batch is not all-or-nothing.** One unsupported change does not lose the
 *   other four; it is quarantined individually with its payload intact
 *   (EVT-03, DEL-06).
 * - **A dedupe key is type-specific.** A message and a status about that same
 *   message are different facts, so they get different keys and one cannot
 *   suppress the other (DEL-05).
 * - **Unsupported is stored, not dropped.** The payload is kept so it can be
 *   rendered as a documented fallback and replayed once support exists (CH-01).
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'whatsapp';
  readonly portVersion = ADAPTER_PORT_VERSION;

  constructor(private readonly crypto: ChannelCrypto) {}

  capabilities(): CapabilityMatrix {
    return capabilitiesFor('whatsapp');
  }

  claims(payload: unknown): boolean {
    return asRecord(payload)?.['object'] === 'whatsapp_business_account';
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
    const events: NormalizedEvent[] = [];
    const quarantined: QuarantinedElement[] = [];
    let assetId: string | null = null;

    const root = asRecord(payload);
    if (root === null || root['object'] !== 'whatsapp_business_account') {
      return {
        assetId: null,
        events: [],
        quarantined: [
          {
            dedupeKey: `wa:malformed:${this.crypto.sha256Hex(JSON.stringify(payload ?? null))}`,
            eventType: 'unknown',
            reason: 'not_a_whatsapp_business_account_envelope',
            payload,
          },
        ],
      };
    }

    for (const entry of asArray(root['entry'])) {
      const entryRecord = asRecord(entry);
      for (const change of asArray(entryRecord?.['changes'])) {
        const changeRecord = asRecord(change);
        const field = asString(changeRecord?.['field']);
        const value = asRecord(changeRecord?.['value']);
        if (value === null) {
          quarantined.push(this.quarantine(change, 'change_has_no_value', field ?? 'unknown'));
          continue;
        }

        // The asset the delivery arrived at. This — not anything the caller
        // supplied — is what resolves the tenant (DEL-02).
        const metadata = asRecord(value['metadata']);
        const phoneNumberId = asString(metadata?.['phone_number_id']);
        if (phoneNumberId !== null) {
          assetId = phoneNumberId;
        }

        if (field !== 'messages') {
          // A WABA can send account-level changes on the same subscription.
          // They are real deliveries with nothing for the inbox to show.
          quarantined.push(this.quarantine(change, 'unsupported_change_field', field ?? 'unknown'));
          continue;
        }

        // The customer's WhatsApp profile name rides beside the messages, keyed
        // by the same wa_id the message is from.
        const names = new Map<string, string>();
        for (const contact of asArray(value['contacts'])) {
          const waId = asString(asRecord(contact)?.['wa_id']);
          const name = asString(asRecord(asRecord(contact)?.['profile'])?.['name'])?.trim().slice(0, 200);
          if (waId !== null && name !== undefined && name !== '') names.set(waId, name);
        }
        for (const message of asArray(value['messages'])) {
          const normalized = this.normalizeMessage(message, phoneNumberId, receivedAt, names);
          if ('reason' in normalized) {
            quarantined.push(normalized);
          } else {
            events.push(normalized);
          }
        }
        for (const status of asArray(value['statuses'])) {
          const normalized = this.normalizeStatus(status, phoneNumberId, receivedAt);
          if ('reason' in normalized) {
            quarantined.push(normalized);
          } else {
            events.push(normalized);
          }
        }
      }
    }

    return { assetId, events, quarantined };
  }

  /* ---------------------------------------------------------------- parts -- */

  private normalizeMessage(
    raw: unknown,
    assetId: string | null,
    receivedAt: Date,
    names: ReadonlyMap<string, string>,
  ): NormalizedEvent | QuarantinedElement {
    const message = asRecord(raw);
    const id = asString(message?.['id']);
    const from = asString(message?.['from']);
    if (message === null || id === null || from === null) {
      return this.quarantine(raw, 'message_missing_id_or_sender', 'messages');
    }
    const type = asString(message['type']) ?? 'unknown';
    const occurredAt = timestampOf(message['timestamp'], receivedAt);

    const text = type === 'text' ? asString(asRecord(message['text'])?.['body']) : null;
    const attachments = this.attachmentsOf(message, type);

    // An unrecognised message type is still a message from a real customer: it
    // is normalized with its payload intact and rendered as a fallback rather
    // than quarantined out of the conversation (CH-01).
    const known = text !== null || attachments.length > 0;
    const name = names.get(from);
    const detail: Record<string, unknown> = known ? {} : { unsupported_type: type };
    if (name !== undefined) detail['sender_name'] = name;
    return {
      kind: known ? 'message' : 'unsupported',
      dedupeKey: `wa:msg:${id}`,
      eventType: `messages.${type}`,
      providerMessageId: id,
      peerIdentity: from,
      assetIdentity: assetId ?? '',
      contentType: type,
      text,
      attachments,
      detail,
      occurredAt,
      source: message,
    };
  }

  private normalizeStatus(
    raw: unknown,
    assetId: string | null,
    receivedAt: Date,
  ): NormalizedEvent | QuarantinedElement {
    const status = asRecord(raw);
    const id = asString(status?.['id']);
    const state = asString(status?.['status']);
    const recipient = asString(status?.['recipient_id']);
    if (status === null || id === null || state === null || recipient === null) {
      return this.quarantine(raw, 'status_missing_fields', 'statuses');
    }

    // `read` and `delivered` are separate kinds, not one status column that a
    // later arrival can overwrite. They fold independently (ADR-0006), so a
    // `read` arriving before `delivered` leaves the timeline at `read`.
    const kind = state === 'read' ? 'read_status' : 'delivery_status';
    return {
      kind,
      // Keyed by state as well as id: the same message legitimately produces
      // sent, delivered and read, and one key would make the second one look
      // like a duplicate of the first.
      dedupeKey: `wa:status:${id}:${state}`,
      eventType: `statuses.${state}`,
      providerMessageId: id,
      peerIdentity: recipient,
      assetIdentity: assetId ?? '',
      contentType: null,
      text: null,
      attachments: [],
      detail: { state, errors: status['errors'] ?? [] },
      occurredAt: timestampOf(status['timestamp'], receivedAt),
      source: status,
    };
  }

  private attachmentsOf(
    message: Record<string, unknown>,
    type: string,
  ): readonly InboundAttachment[] {
    const media = asRecord(message[type]);
    if (media === null) {
      return [];
    }
    const providerId = asString(media['id']);
    if (providerId === null) {
      return [];
    }
    return [
      {
        type,
        providerId,
        mimeType: asString(media['mime_type']),
        caption: asString(media['caption']),
      },
    ];
  }

  private quarantine(payload: unknown, reason: string, eventType: string): QuarantinedElement {
    return {
      // Content-addressed, so redelivering the same broken element does not
      // pile up rows.
      dedupeKey: `wa:quarantine:${this.crypto.sha256Hex(JSON.stringify(payload ?? null))}`,
      eventType,
      reason,
      payload,
    };
  }
}

/* --------------------------------------------------------------- helpers -- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * WhatsApp sends epoch seconds as a string. A missing or unparsable timestamp
 * falls back to when we received it, because the event is real either way and
 * dropping it over a bad clock field would lose a customer's message.
 */
function timestampOf(value: unknown, fallback: Date): Date {
  const seconds = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : fallback;
}
