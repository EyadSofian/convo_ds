import { describe, expect, it } from 'vitest';
import { splitBatchByAsset } from './batch.js';
import type { NormalizedEvent, QuarantinedElement } from './port.js';

const event = (dedupeKey: string, assetIdentity: string): NormalizedEvent => ({
  kind: 'message', dedupeKey, eventType: 'messaging.message', providerMessageId: dedupeKey,
  peerIdentity: 'customer', assetIdentity, contentType: 'text', text: 'hi', attachments: [], detail: {},
  occurredAt: new Date(0), source: {},
});
const held: QuarantinedElement = { dedupeKey: 'held', eventType: 'entry', reason: 'entry_has_no_messaging', payload: {} };

describe('splitting a delivery by asset', () => {
  it('keeps a single-asset delivery as one part', () => {
    const batch = { assetId: 'page-a', events: [event('1', 'page-a')], quarantined: [held] };
    expect(splitBatchByAsset(batch)).toEqual([batch]);
  });

  it('gives each Page its own events, however Meta batched them', () => {
    const parts = splitBatchByAsset({
      assetId: 'page-b',
      events: [event('1', 'page-a'), event('2', 'page-b'), event('3', 'page-a')],
      quarantined: [held],
    });
    expect(parts.map((part) => [part.assetId, part.events.map((item) => item.dedupeKey), part.quarantined.length])).toEqual([
      ['page-a', ['1', '3'], 0],
      ['page-b', ['2'], 1],
    ]);
  });

  it('routes an event with no asset of its own to the asset of the batch', () => {
    const parts = splitBatchByAsset({ assetId: 'page-a', events: [event('1', '')], quarantined: [] });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.assetId).toBe('page-a');
  });

  it('still keeps what was held when nothing else was readable for that asset', () => {
    const parts = splitBatchByAsset({ assetId: 'page-b', events: [event('1', 'page-a')], quarantined: [held] });
    expect(parts.map((part) => [part.assetId, part.events.length, part.quarantined.length])).toEqual([
      ['page-a', 1, 0],
      ['page-b', 0, 1],
    ]);
    expect(splitBatchByAsset({ assetId: 'page-b', events: [], quarantined: [] })).toEqual([{ assetId: 'page-b', events: [], quarantined: [] }]);
  });
});
