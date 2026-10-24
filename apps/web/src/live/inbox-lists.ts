import type { LiveContext } from './actions.js';
import { unassignedFilterProjection } from './inbox-query.js';
import type { LiveState } from './store.js';
import { claimRead, failed, forTenant, ready, singleFlight } from './store.js';

/**
 * Starts a read of the inbox lists; the returned check says whether it is still
 * the newest. Two reads of the same lists overlap all the time — a realtime
 * event lands while a sort change is loading, a claim re-reads while a reset
 * reloads — and whichever answer arrived last used to win, even when it
 * answered an older question. That is how a list ended up showing the previous
 * sort, or stayed on its placeholders.
 */
export function claimInboxRead(live: LiveState): () => boolean {
  return claimRead(live, 'inbox-lists');
}

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
 *
 * **One read at a time.** A burst of events — a busy inbox, or a stream
 * catching up — asks for many refreshes in a row. They are folded into the one
 * already running plus at most one more after it, so twenty events cost two
 * pairs of requests rather than twenty. Every caller's promise settles once a
 * read that started after its call has finished, so a caller that just changed
 * something still gets lists that include the change.
 */
export function refreshInboxLists(context: LiveContext): Promise<void> {
  return singleFlight(context.live, 'inbox-lists', () => readInboxLists(context));
}

async function readInboxLists(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const current = claimInboxRead(live);
    const [unassigned, mine] = await Promise.all([
      // A realtime event refreshes the first visible page of the *same*
      // operational query. Dropping these would silently turn an Agent/Label
      // queue into an unfiltered one after the first incoming message.
      live.conversationsApi.unassigned(tenantId, unassignedFilterProjection(live.inboxQuery)),
      live.supervisorAgentId === null
        ? live.conversationsApi.list(tenantId, live.inboxQuery)
        : live.conversationsApi.supervisorList(tenantId, live.supervisorAgentId, live.inboxQuery),
    ]);
    // A newer read — a filter, a sort, a reset — owns the lists now.
    if (!current()) return;
    const now = context.now();
    if (live.supervisorAgentId === null) {
      if (unassigned.ok) live.unassigned = ready(unassigned.data, now);
      // Nothing on screen to keep: a list still on its placeholders that
      // cannot be read says so, rather than shimmering forever.
      else if (live.unassigned.status !== 'ready') live.unassigned = failed(unassigned.error);
    }
    if (mine.ok) {
      live.conversations = ready(mine.data.items, now);
      // Realtime always replaces the visible first page.  An old cursor points
      // into a snapshot that may have changed, so continuing it could skip or
      // duplicate work; expose only the new continuation from this response.
      live.inboxNextCursor = mine.data.nextCursor;
    } else if (live.conversations.status !== 'ready') {
      live.conversations = failed(mine.error);
    }
    context.refresh();
  });
}
