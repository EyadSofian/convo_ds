import type { LiveContext } from './actions.js';
import { unassignedFilterProjection } from './inbox-query.js';
import { forTenant, ready } from './store.js';

/**
 * Re-reads the two inbox lists without blanking them first.
 *
 * Its own module because two different concerns need it — a realtime event
 * arriving, and a lifecycle transition completing — and neither should have to
 * import the other to get it.
 *
 * Nothing here blanks a resource: a realtime event should not make the queue
 * flash empty and refill, so the rows on screen stay until the newer ones
 * replace them. A failed re-read leaves the last good answer standing, which is
 * more honest than an empty list nobody asked for.
 */
export async function refreshInboxLists(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const [unassigned, mine] = await Promise.all([
      // A realtime event refreshes the first visible page of the *same*
      // operational query. Dropping these would silently turn an Agent/Label
      // queue into an unfiltered one after the first incoming message.
      live.conversationsApi.unassigned(tenantId, unassignedFilterProjection(live.inboxQuery)),
      live.supervisorAgentId === null
        ? live.conversationsApi.list(tenantId, live.inboxQuery)
        : live.conversationsApi.supervisorList(tenantId, live.supervisorAgentId, live.inboxQuery),
    ]);
    const now = context.now();
    if (live.supervisorAgentId === null && unassigned.ok) {
      live.unassigned = ready(unassigned.data, now);
    }
    if (mine.ok) {
      live.conversations = ready(mine.data.items, now);
      // Realtime always replaces the visible first page.  An old cursor points
      // into a snapshot that may have changed, so continuing it could skip or
      // duplicate work; expose only the new continuation from this response.
      live.inboxNextCursor = mine.data.nextCursor;
    }
    context.refresh();
  });
}
