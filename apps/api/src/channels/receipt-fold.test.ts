import { describe, expect, it } from 'vitest';
import { foldReceipts } from './receipt-fold.js';
import type { ReceiptRow } from './receipt-fold.js';

/**
 * The regression these cover is a broadcast reporting as unread.
 *
 * A provider's `sent`, `delivered` and `read` for one send arrive together and
 * are normalised together, so they share an observation instant and come back
 * from the sweep in no particular order. Deciding the message row by row made
 * the last row win; the state an operator is shown then depended on how the
 * database felt like sorting a tie.
 */

const BURST = new Date('2026-11-16T09:00:00.000Z');

function receipt(state: ReceiptRow['incoming_state'], seconds: number, id: string, overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    receipt_id: id,
    provider_message_id: 'wamid.one',
    incoming_state: state,
    failure_code: null,
    occurred_at: new Date(BURST.getTime() + seconds * 1000),
    // One normalisation pass, one instant, for every row.
    observed_at: BURST,
    message_id: 'message-1',
    delivery_state: null,
    delivery_state_at: null,
    delivery_anomaly: null,
    connection_id: 'connection-1',
    peer_identity: '201000000000',
    ...overrides,
  };
}

describe('foldReceipts', () => {
  it('takes the highest receipt whatever order the sweep returned them in', () => {
    const rows = [receipt('sent', 0, 'c'), receipt('delivered', 1, 'a'), receipt('read', 2, 'b')];
    for (const order of [rows, [...rows].reverse(), [rows[1]!, rows[2]!, rows[0]!]]) {
      const [message] = foldReceipts(order);
      expect(message?.fold.state).toBe('read');
      // The three agreed with each other. Only a provider contradicting itself
      // is an anomaly, and sorting is not the provider.
      expect(message?.fold.anomaly).toBeNull();
      expect(message?.changed).toBe(true);
    }
  });

  it('resumes from the furthest receipt it observed, not the latest one sent', () => {
    // The cursor is a resume point into the event table, so it follows our own
    // order. The fold follows the provider's.
    const later = new Date(BURST.getTime() + 60_000);
    const [message] = foldReceipts([
      receipt('read', 9, 'b'),
      receipt('sent', 0, 'z', { observed_at: later }),
    ]);
    expect(message?.cursorAt).toEqual(later);
    expect(message?.cursorId).toBe('z');
    expect(message?.fold.state).toBe('read');
  });

  it('folds each message on its own', () => {
    const other = { message_id: 'message-2', provider_message_id: 'wamid.two' };
    const messages = foldReceipts([
      receipt('delivered', 1, 'a'),
      receipt('sent', 0, 'b', other),
      receipt('read', 2, 'c'),
    ]);
    expect(messages.map((message) => [message.messageId, message.fold.state])).toEqual([
      ['message-1', 'read'],
      ['message-2', 'sent'],
    ]);
  });

  it('builds on what the message already recorded', () => {
    const held = { delivery_state: 'read', delivery_state_at: new Date(BURST.getTime() + 2000), delivery_anomaly: null };
    const [message] = foldReceipts([receipt('delivered', 1, 'a', held)]);
    // Nothing new: a `delivered` the provider stamped before the read we hold.
    expect(message?.fold.state).toBe('read');
    expect(message?.changed).toBe(false);
  });

  it('breaks a tie on the provider clock by our own order without inventing a conflict', () => {
    // WhatsApp stamps receipts to the second, so a delivered and a read for a
    // message opened at once share a timestamp.
    const [message] = foldReceipts([
      receipt('delivered', 1, 'a', { observed_at: new Date(BURST.getTime() + 5) }),
      receipt('read', 1, 'b'),
    ]);
    expect(message?.fold.state).toBe('read');
    expect(message?.fold.anomaly).toBeNull();
  });

  it('carries the reason a send failed', () => {
    const [message] = foldReceipts([
      receipt('sent', 0, 'a'),
      receipt('failed', 1, 'b', { failure_code: '131026' }),
    ]);
    expect(message?.fold.state).toBe('failed');
    expect(message?.failureCode).toBe('131026');
  });
});
