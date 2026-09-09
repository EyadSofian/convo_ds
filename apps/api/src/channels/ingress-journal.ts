import type { NormalizedBatch, SqlExecutor } from '@convo/domain';
import { requireRow } from '../require-row.js';
import type { IngressDelivery } from './ingress.service.js';

/**
 * The durable half of ingress, shared by every route that receives a delivery.
 *
 * Extracted rather than duplicated because "what a receipt is" and "what makes
 * a redelivery one effect" must be the same answer for a Meta webhook and for a
 * widget. Two copies of a dedupe rule is two dedupe rules, and the second one is
 * wrong the first time somebody edits only the first.
 */

export interface ReceiptInput {
  readonly appId: string | null;
  readonly delivery: IngressDelivery;
  readonly bodySha: string;
  readonly signatureValid: boolean;
  readonly outcome: string;
  readonly tenantId: string | null;
  readonly eventCount: number;
}

export async function writeReceipt(sql: SqlExecutor, input: ReceiptInput): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `INSERT INTO webhook_receipts
       (app_id, route_key, body_sha256, body_bytes, signature_valid, outcome, tenant_id, event_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id::text`,
    [
      input.appId,
      input.delivery.routeKey,
      input.bodySha,
      input.delivery.rawBody.byteLength,
      input.signatureValid,
      input.outcome,
      input.tenantId,
      input.eventCount,
    ],
  );
  return requireRow(rows.rows, 'receipt insert returned no id').id;
}

export interface JournalInput {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly receiptId: string;
  readonly batch: NormalizedBatch;
}

export interface JournalResult {
  readonly stored: number;
  readonly duplicates: number;
}

/**
 * Journals a normalized batch, and marks the connection as having received.
 *
 * A quarantined element is stored beside its siblings rather than losing the
 * batch (EVT-03), and is not queued: there is nothing for a worker to do with
 * it beyond what the row already records.
 */
export async function journalBatch(sql: SqlExecutor, input: JournalInput): Promise<JournalResult> {
  let stored = 0;
  let duplicates = 0;

  for (const event of input.batch.events) {
    const inserted = await insertEvent(sql, {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      receiptId: input.receiptId,
      dedupeKey: event.dedupeKey,
      eventType: event.eventType,
      // The provider's element is the evidence; the normalized form is what the
      // projection is built from. Both are kept.
      payload: event.source,
      normalized: event,
      quarantineReason: null,
    });
    if (inserted) stored += 1;
    else duplicates += 1;
  }
  for (const element of input.batch.quarantined) {
    const inserted = await insertEvent(sql, {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      receiptId: input.receiptId,
      dedupeKey: element.dedupeKey,
      eventType: element.eventType,
      payload: element.payload,
      normalized: null,
      quarantineReason: element.reason,
    });
    if (inserted) stored += 1;
    else duplicates += 1;
  }

  // Receiving is itself evidence, and the ingress is the only thing that can
  // observe it. `coalesce` so a later delivery does not move the mark.
  await sql.query(
    `UPDATE channel_connections
        SET first_inbound_at = coalesce(first_inbound_at, now()),
            webhook_subscribed_at = coalesce(webhook_subscribed_at, now())
      WHERE id = $1`,
    [input.connectionId],
  );

  return { stored, duplicates };
}

interface EventInsert {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly receiptId: string;
  readonly dedupeKey: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly normalized: unknown;
  readonly quarantineReason: string | null;
}

/**
 * Inserts one event, or reports that it was already here.
 *
 * `ON CONFLICT DO NOTHING` on the per-tenant dedupe key is what makes
 * redelivery safe (DEL-05, EVT-02): the same fact arriving twice, in two
 * differently ordered batches, produces one row and therefore one domain
 * effect — and the duplicate is counted rather than silently ignored, so an
 * operator can see redelivery happening.
 */
async function insertEvent(sql: SqlExecutor, event: EventInsert): Promise<boolean> {
  const inserted = await sql.query<{ id: string }>(
    `INSERT INTO channel_events
       (tenant_id, connection_id, receipt_id, dedupe_key, event_type, payload, normalized,
        status, quarantine_reason, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, coalesce($8::jsonb, '{}'::jsonb),
             CASE WHEN $7::text IS NULL THEN 'received' ELSE 'quarantined' END,
             $7,
             -- A quarantined element has already been dealt with: it is not
             -- waiting for a normalizer, so it carries a processing time.
             CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
     RETURNING id::text`,
    [
      event.tenantId,
      event.connectionId,
      event.receiptId,
      event.dedupeKey,
      event.eventType,
      JSON.stringify(event.payload ?? null),
      event.quarantineReason,
      event.normalized === null ? null : JSON.stringify(event.normalized),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    return false;
  }
  if (event.quarantineReason === null) {
    await sql.query(
      `INSERT INTO channel_event_queue (event_id, tenant_id) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [row.id, event.tenantId],
    );
  }
  return true;
}
