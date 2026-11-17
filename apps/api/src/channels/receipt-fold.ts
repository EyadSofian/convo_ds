import { foldDelivery } from '@convo/domain';
import type { DeliveryFold, DeliveryState } from '@convo/domain';

/**
 * Grouping a sweep's receipts into one decision per message.
 *
 * A sweep reads rows, not messages: a broadcast's `sent`, `delivered` and
 * `read` for the same send come back as three rows that have to become one
 * state. Doing that row by row against the state the sweep read at the top is
 * what made the **last** row win rather than the **highest** — a message that
 * was delivered and read recorded as merely sent, and a broadcast report that
 * said nobody received it.
 *
 * It is a pure function, separate from the service, because the ordering rules
 * below are the whole of the correctness and they are worth asserting directly
 * rather than only through a database.
 */

/** One receipt joined to the message it is about, as the sweep selects it. */
export interface ReceiptRow {
  readonly receipt_id: string;
  readonly provider_message_id: string;
  readonly incoming_state: DeliveryState;
  /** The provider's error code, on the receipt that reported a failure. */
  readonly failure_code: string | null;
  /** The provider's clock. */
  readonly occurred_at: Date;
  /** Ours, written when the receipt was normalised. */
  readonly observed_at: Date;
  readonly message_id: string;
  readonly delivery_state: string | null;
  readonly delivery_state_at: Date | null;
  readonly delivery_anomaly: string | null;
  readonly connection_id: string;
  readonly peer_identity: string;
}

export interface FoldedMessage {
  readonly messageId: string;
  readonly connectionId: string;
  readonly peerIdentity: string;
  /** What every new receipt for this message, folded together, amounts to. */
  readonly fold: DeliveryFold;
  /** Carried for the state above, so a failed broadcast recipient says why. */
  readonly failureCode: string | null;
  /** Whether that differs from what the message already recorded. */
  readonly changed: boolean;
  /** The (observed_at, id) pair the message's fold cursor advances to. */
  readonly cursorAt: Date;
  readonly cursorId: string;
}

export function foldReceipts(rows: readonly ReceiptRow[]): readonly FoldedMessage[] {
  const grouped = new Map<string, ReceiptRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.message_id);
    if (existing === undefined) {
      grouped.set(row.message_id, [row]);
    } else {
      existing.push(row);
    }
  }

  const messages: FoldedMessage[] = [];
  for (const [messageId, receipts] of grouped) {
    // The provider's order, not ours. Folding by when *we* happened to write
    // the rows would record a `delivered_after_read` anomaly for a provider
    // that reported the two in the right order and whose receipts merely shared
    // one normalisation pass.
    const ordered = [...receipts].sort(byProviderOrder);
    const first = ordered[0] as ReceiptRow;

    let fold: DeliveryFold | null =
      first.delivery_state === null || first.delivery_state_at === null
        ? null
        : {
            state: first.delivery_state as DeliveryState,
            at: first.delivery_state_at,
            anomaly: first.delivery_anomaly,
          };
    let failureCode: string | null = null;
    for (const receipt of ordered) {
      fold = foldDelivery(fold, { state: receipt.incoming_state, at: receipt.occurred_at });
      if (receipt.incoming_state === 'failed') {
        failureCode = receipt.failure_code;
      }
    }

    // The cursor is the furthest receipt this sweep considered, which is the
    // last in *our* order rather than the provider's: it is a resume point into
    // `inbound_events`, and that table is ordered by when we observed it.
    const cursor = receipts.reduce((furthest, row) => (bySweepOrder(row, furthest) > 0 ? row : furthest), receipts[0] as ReceiptRow);
    const settled = fold as DeliveryFold;
    messages.push({
      messageId,
      connectionId: first.connection_id,
      peerIdentity: first.peer_identity,
      fold: settled,
      failureCode,
      changed: settled.state !== first.delivery_state || settled.anomaly !== first.delivery_anomaly,
      cursorAt: cursor.observed_at,
      cursorId: cursor.receipt_id,
    });
  }
  return messages;
}

/** Ties on the provider's clock fall back to ours, then to the row's identity. */
function byProviderOrder(left: ReceiptRow, right: ReceiptRow): number {
  const occurred = left.occurred_at.getTime() - right.occurred_at.getTime();
  return occurred === 0 ? bySweepOrder(left, right) : occurred;
}

function bySweepOrder(left: ReceiptRow, right: ReceiptRow): number {
  const observed = left.observed_at.getTime() - right.observed_at.getTime();
  return observed === 0 ? left.receipt_id.localeCompare(right.receipt_id) : observed;
}
