import type { LiveContext } from './actions.js';
import { forTenant, fromResult, LOADING } from './store.js';

/** Loads the two tenant-owned catalogues used by Inbox and Contacts. */
export async function loadMetadataCatalog(context: LiveContext): Promise<void> {
  return forTenant(context, undefined, async (tenantId) => {
    context.live.labels = LOADING;
    context.live.customFields = LOADING;
    context.refresh();
    const [labels, fields] = await Promise.all([
      context.live.metadataApi.labels(tenantId),
      context.live.metadataApi.fields(tenantId),
    ]);
    const now = context.now();
    context.live.labels = fromResult(labels, now);
    context.live.customFields = fromResult(fields, now);
    context.refresh();
  });
}
