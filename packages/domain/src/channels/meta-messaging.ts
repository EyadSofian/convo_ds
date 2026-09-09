import type { ChannelCrypto } from './crypto.js';
import type { ChannelKind } from './kinds.js';
import type { InboundAttachment, NormalizedBatch, NormalizedEvent, QuarantinedElement } from './port.js';

/**
 * The `entry[].messaging[]` envelope that Messenger and Instagram both use.
 *
 * **What is shared here is a wire shape, not a rule.** Both products are
 * delivered by one Meta app over one webhook, and the JSON they send has the
 * same outer skeleton. Parsing that skeleton twice would not make the channels
 * more independent; it would make one of the copies wrong later.
 *
 * What is deliberately *not* here: capability matrices, reply windows,
 * initiation rules, template support, and every per-channel event type. Those
 * live in each adapter, because that is where they actually differ and where
 * sharing them would produce the exact failure ADR-0009 exists to prevent — an
 * Instagram conversation judged by Messenger's rules.
 */

export interface MetaMessagingOptions {
  readonly kind: ChannelKind;
  /** The value of `object` this channel answers to: `page` or `instagram`. */
  readonly envelopeObject: string;
  /** Prefix for dedupe keys, so two channels' ids can never collide. */
  readonly keyPrefix: string;
  /**
   * Per-channel item types beyond message, delivery and read.
   *
   * Returning `null` means "not mine", and the item is quarantined with its
   * payload intact rather than dropped.
   */
  extra?(
    item: Record<string, unknown>,
    context: MessagingContext,
  ): NormalizedEvent | null;
}

export interface MessagingContext {
  readonly senderId: string;
  readonly recipientId: string;
  readonly assetId: string;
  readonly occurredAt: Date;
  readonly keyPrefix: string;
}

export function normalizeMetaMessaging(
  payload: unknown,
  receivedAt: Date,
  crypto: ChannelCrypto,
  options: MetaMessagingOptions,
): NormalizedBatch {
  const events: NormalizedEvent[] = [];
  const quarantined: QuarantinedElement[] = [];
  let assetId: string | null = null;

  const root = asRecord(payload);
  if (root === null || root['object'] !== options.envelopeObject) {
    return {
      assetId: null,
      events: [],
      quarantined: [
        quarantine(crypto, options.keyPrefix, payload, 'unknown', `not_a_${options.envelopeObject}_envelope`),
      ],
    };
  }

  for (const entry of asArray(root['entry'])) {
    const entryRecord = asRecord(entry);
    // The asset is the entry id: the Page or the Instagram professional
    // account this delivery is about. It — not any header — resolves the tenant.
    const entryId = asString(entryRecord?.['id']);
    if (entryId !== null) {
      assetId = entryId;
    }

    const items = asArray(entryRecord?.['messaging']);
    if (items.length === 0) {
      quarantined.push(
        quarantine(crypto, options.keyPrefix, entry, 'entry', 'entry_has_no_messaging'),
      );
      continue;
    }

    for (const item of items) {
      const record = asRecord(item);
      const senderId = asString(asRecord(record?.['sender'])?.['id']);
      const recipientId = asString(asRecord(record?.['recipient'])?.['id']);
      if (record === null || senderId === null || recipientId === null) {
        quarantined.push(
          quarantine(crypto, options.keyPrefix, item, 'messaging', 'messaging_missing_participants'),
        );
        continue;
      }

      const context: MessagingContext = {
        senderId,
        recipientId,
        assetId: entryId ?? '',
        occurredAt: timestampOf(record['timestamp'], receivedAt),
        keyPrefix: options.keyPrefix,
      };

      const normalized = normalizeItem(record, context, options);
      if (normalized === null) {
        quarantined.push(
          quarantine(crypto, options.keyPrefix, item, 'messaging', 'unsupported_messaging_item'),
        );
      } else {
        events.push(...normalized);
      }
    }
  }

  return { assetId, events, quarantined };
}

/**
 * One `messaging` item, which may produce several facts.
 *
 * A `delivery` names a list of message ids, so it is genuinely several receipts
 * arriving together; flattening it to one would lose all but the first.
 */
function normalizeItem(
  item: Record<string, unknown>,
  context: MessagingContext,
  options: MetaMessagingOptions,
): readonly NormalizedEvent[] | null {
  const message = asRecord(item['message']);
  if (message !== null) {
    const mid = asString(message['mid']);
    if (mid === null) {
      return null;
    }
    const text = asString(message['text']);
    const attachments = attachmentsOf(message);
    // An echo is our own message coming back. It is a real event that must not
    // be shown as an inbound customer message, so it is kept with its own type.
    const isEcho = message['is_echo'] === true;
    const known = text !== null || attachments.length > 0;
    return [
      {
        kind: isEcho ? 'unsupported' : known ? 'message' : 'unsupported',
        dedupeKey: `${context.keyPrefix}:msg:${mid}`,
        eventType: isEcho ? 'messaging.echo' : 'messaging.message',
        providerMessageId: mid,
        peerIdentity: context.senderId,
        assetIdentity: context.assetId,
        contentType: text !== null ? 'text' : (attachments[0]?.type ?? 'unknown'),
        text,
        attachments,
        detail: isEcho ? { echo: true } : known ? {} : { unsupported_message: true },
        occurredAt: context.occurredAt,
        source: item,
      },
    ];
  }

  const delivery = asRecord(item['delivery']);
  if (delivery !== null) {
    const mids = asArray(delivery['mids']).filter((mid): mid is string => typeof mid === 'string');
    if (mids.length === 0) {
      return null;
    }
    return mids.map((mid) => ({
      kind: 'delivery_status' as const,
      dedupeKey: `${context.keyPrefix}:status:${mid}:delivered`,
      eventType: 'messaging.delivery',
      providerMessageId: mid,
      peerIdentity: context.senderId,
      assetIdentity: context.assetId,
      contentType: null,
      text: null,
      attachments: [],
      detail: { watermark: delivery['watermark'] ?? null },
      occurredAt: context.occurredAt,
      source: item,
    }));
  }

  const read = asRecord(item['read']);
  if (read !== null) {
    // A read receipt is a watermark, not a message id: everything up to that
    // moment was read. There is no id to key on, so the watermark is the key.
    const watermark = read['watermark'];
    if (typeof watermark !== 'number' && typeof watermark !== 'string') {
      return null;
    }
    return [
      {
        kind: 'read_status',
        dedupeKey: `${context.keyPrefix}:read:${context.senderId}:${String(watermark)}`,
        eventType: 'messaging.read',
        // Deliberately null: a watermark says "everything before this", and
        // pretending it names one message would attach it to the wrong one.
        providerMessageId: null,
        peerIdentity: context.senderId,
        assetIdentity: context.assetId,
        contentType: null,
        text: null,
        attachments: [],
        detail: { watermark },
        occurredAt: context.occurredAt,
        source: item,
      },
    ];
  }

  const extra = options.extra?.(item, context);
  return extra === null || extra === undefined ? null : [extra];
}

function attachmentsOf(message: Record<string, unknown>): readonly InboundAttachment[] {
  const result: InboundAttachment[] = [];
  for (const raw of asArray(message['attachments'])) {
    const attachment = asRecord(raw);
    const type = asString(attachment?.['type']);
    const url = asString(asRecord(attachment?.['payload'])?.['url']);
    if (type === null) {
      continue;
    }
    result.push({
      type,
      // Meta hands these back as signed URLs rather than ids. The URL *is* the
      // handle, and it is stored as one rather than fetched here.
      providerId: url ?? '',
      mimeType: null,
      caption: null,
    });
  }
  return result;
}

/* ----------------------------------------------------------------- shared -- */

export function quarantine(
  crypto: ChannelCrypto,
  keyPrefix: string,
  payload: unknown,
  eventType: string,
  reason: string,
): QuarantinedElement {
  return {
    dedupeKey: `${keyPrefix}:quarantine:${crypto.sha256Hex(JSON.stringify(payload ?? null))}`,
    eventType,
    reason,
    payload,
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Meta's messaging products send epoch **milliseconds**, unlike WhatsApp's
 * seconds. Getting that wrong puts every message fifty thousand years in the
 * future, which is why the two are converted in their own places.
 */
export function timestampOf(value: unknown, fallback: Date): Date {
  const millis = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(millis) && millis > 0 ? new Date(millis) : fallback;
}
