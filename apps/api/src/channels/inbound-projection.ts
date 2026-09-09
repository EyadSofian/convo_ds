import type { InboundKind } from '@convo/domain';
import { INBOUND_KINDS } from '@convo/domain';

/**
 * The journalled event, as a row the normalized table will accept.
 *
 * Total by construction. What it reads came out of `jsonb`, so every field is
 * `unknown` no matter how confident the adapter was when it wrote it — a schema
 * change, a replayed old event, or an adapter bug all arrive here as a shape
 * that does not match. The answer to each is a defined default rather than a
 * throw, because the alternative is one malformed row stopping a worker that is
 * draining a customer's messages.
 *
 * It is a separate pure function, rather than inline in the worker, so all of
 * that can be asserted directly instead of only through a database.
 */
export interface InboundRow {
  readonly kind: InboundKind;
  readonly providerMessageId: string | null;
  readonly peerIdentity: string;
  readonly assetIdentity: string;
  readonly contentType: string | null;
  readonly text: string | null;
  readonly attachments: string;
  readonly detail: string;
  readonly occurredAt: Date;
}

export function inboundRowFrom(event: Record<string, unknown>, fallbackTime: Date): InboundRow {
  const providerMessageId = stringOrNull(event['providerMessageId']);
  const kind = kindOf(event['kind']);
  return {
    // A message with no provider id would violate the table's own check. It
    // cannot arise from the WhatsApp normalizer — a message without an id is
    // quarantined before it gets here — so an adapter bug degrades to
    // `unsupported`, which is visible, rather than crashing the drain.
    kind: kind === 'message' && providerMessageId === null ? 'unsupported' : kind,
    providerMessageId,
    peerIdentity: stringOrNull(event['peerIdentity']) ?? '',
    assetIdentity: stringOrNull(event['assetIdentity']) ?? '',
    contentType: stringOrNull(event['contentType']),
    text: stringOrNull(event['text']),
    attachments: JSON.stringify(event['attachments'] ?? []),
    detail: JSON.stringify(event['detail'] ?? {}),
    occurredAt: occurredAt(event['occurredAt'], fallbackTime),
  };
}

function kindOf(value: unknown): InboundKind {
  return typeof value === 'string' && (INBOUND_KINDS as readonly string[]).includes(value)
    ? (value as InboundKind)
    : 'unsupported';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The stored timestamp, which went through JSON and is therefore a string.
 *
 * An unreadable value falls back to the caller's clock rather than failing: the
 * event is real, and losing it over a clock field is a worse answer than an
 * approximate time that `observed_at` sits next to in the same row.
 */
function occurredAt(value: unknown, fallback: Date): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}
