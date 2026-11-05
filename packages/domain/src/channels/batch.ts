import type { NormalizedBatch, NormalizedEvent } from './port.js';

/**
 * One delivery, split by the asset each event belongs to.
 *
 * A provider may batch several Pages or numbers into one webhook. A batch carries
 * a single `assetId`, so routing it whole sends every Page's customers to
 * whichever Page came last — or drops them all when that one is not connected
 * here. Elements that could not be read have no asset of their own and stay with
 * the batch's.
 */
export function splitBatchByAsset(batch: NormalizedBatch & { readonly assetId: string }): readonly (NormalizedBatch & { readonly assetId: string })[] {
  const events = new Map<string, NormalizedEvent[]>();
  for (const event of batch.events) {
    const asset = event.assetIdentity === '' ? batch.assetId : event.assetIdentity;
    events.set(asset, [...(events.get(asset) ?? []), event]);
  }
  const parts = [...events].map(([assetId, grouped]) => ({
    assetId,
    events: grouped,
    quarantined: assetId === batch.assetId ? batch.quarantined : [],
  }));
  // Nothing readable for the batch's own asset, yet something was held for it.
  return events.has(batch.assetId) ? parts : [...parts, { assetId: batch.assetId, events: [], quarantined: batch.quarantined }];
}
