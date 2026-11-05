import { asArray, asRecord, asString } from './meta-messaging.js';
import type { ChannelAdapter, NormalizedBatch } from './port.js';

/**
 * Bringing messages in that the webhook never delivered.
 *
 * A webhook only reports what happens after a Page is subscribed, and only to an
 * app that has access to that person. Graph's Conversations API can still answer
 * for the rest: the same customers, the same message ids. Each message is rebuilt
 * as the webhook item Meta would have sent, so it is parsed by the one parser and
 * deduplicated by the one key — a message that later arrives by webhook, or
 * already did, is one row.
 */

/** Graph answers these fields for the 20 newest messages of a conversation. */
export const META_HISTORY_MESSAGE_FIELDS =
  'id,created_time,from,to,message,attachments{mime_type,name,file_url,image_data{url},video_data{url}}';

function attachmentType(mimeType: string | null): string {
  if (mimeType?.startsWith('image/') === true) return 'image';
  if (mimeType?.startsWith('video/') === true) return 'video';
  if (mimeType?.startsWith('audio/') === true) return 'audio';
  return 'file';
}

function attachmentsOf(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  return asArray(asRecord(message['attachments'])?.['data']).map((raw) => {
    const attachment = asRecord(raw);
    const url = asString(asRecord(attachment?.['image_data'])?.['url'])
      ?? asString(asRecord(attachment?.['video_data'])?.['url'])
      ?? asString(attachment?.['file_url']);
    return { type: attachmentType(asString(attachment?.['mime_type'])), payload: { url } };
  });
}

/** `null` for anything without an id and both participants: nothing to key on. */
export function graphMessageToWebhookItem(raw: unknown, assetId: string): Record<string, unknown> | null {
  const message = asRecord(raw);
  if (message === null) return null;
  const mid = asString(message['id']);
  const from = asString(asRecord(message['from'])?.['id']);
  const to = asString(asRecord(asArray(asRecord(message['to'])?.['data'])[0])?.['id']);
  if (mid === null || from === null || to === null) return null;
  return {
    sender: { id: from },
    recipient: { id: to },
    // An unreadable time parses to NaN, which `timestampOf` replaces.
    timestamp: Date.parse(asString(message['created_time']) ?? ''),
    message: {
      mid,
      text: asString(message['message']),
      attachments: attachmentsOf(message),
      // The business is a participant like any other here, and only by the id
      // can its own messages be told from the customer's.
      is_echo: from === assetId,
    },
  };
}

/** Marks events as historic, so nothing about them wakes a queue or a person. */
function markedHistoric(batch: NormalizedBatch): NormalizedBatch {
  return {
    ...batch,
    events: batch.events.map((event) => ({ ...event, detail: { ...event.detail, history: true } })),
  };
}

function envelopeObject(adapter: ChannelAdapter): string {
  return adapter.kind === 'instagram' ? 'instagram' : 'page';
}

/** What Graph returned for a Page or Instagram account, as an ordinary batch. */
export function normalizeMetaHistory(
  adapter: ChannelAdapter,
  assetId: string,
  messages: readonly unknown[],
  receivedAt: Date,
): NormalizedBatch {
  const items = messages.flatMap((message) => graphMessageToWebhookItem(message, assetId) ?? []);
  if (items.length === 0) return { assetId, events: [], quarantined: [] };
  return markedHistoric(adapter.normalize(
    { object: envelopeObject(adapter), entry: [{ id: assetId, messaging: items }] },
    receivedAt,
  ));
}

/**
 * Entries an earlier build could not read, journaled intact for this moment.
 *
 * Standby deliveries were held as `entry_has_no_messaging`. Their payload is the
 * evidence, so reading them again is all a recovery has to do.
 */
export function normalizeHeldEntries(
  adapter: ChannelAdapter,
  entries: readonly unknown[],
  receivedAt: Date,
): NormalizedBatch {
  return markedHistoric(adapter.normalize({ object: envelopeObject(adapter), entry: entries }, receivedAt));
}
