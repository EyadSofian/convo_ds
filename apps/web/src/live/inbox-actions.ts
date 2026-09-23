import type { ApiError } from '../api/client.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadOpenContact } from './contact-actions.js';
import { refreshInboxLists } from './inbox-lists.js';
import { unassignedFilterProjection } from './inbox-query.js';
import { loadEpisodes, loadNotes, markConversationRead } from './lifecycle-actions.js';
import { loadRouting } from './routing-actions.js';
import { subscribe } from './realtime.js';
import type { EventSourceFactory, RealtimeEvent } from './realtime.js';
import { currentTenantId, failed, forTenant, fromResult, LOADING, ready, rowsOf } from './store.js';
import { loadMetadataCatalog } from './metadata-catalog.js';
import { loadSavedViews } from './saved-view-actions.js';

/**
 * The Inbox, against the real API.
 *
 * Two rules shape every function here.
 *
 * **A realtime event says what changed; the server says what it is.** An event
 * is not applied as data. It marks the affected lists stale and triggers a
 * re-read of the endpoints that own them. That costs a request, and it buys the
 * thing that matters: an agent who may only *preview* a conversation receives a
 * projected card, so patching local state from event payloads would leave the
 * screen holding a mixture of records and cards and no way to tell which is
 * which. Re-reading gets the caller exactly what they are allowed, every time.
 *
 * **Nothing is written locally before the server agrees.** A reply appears on
 * the timeline when the command exists, not when the button was pressed; a
 * claim moves a conversation when the claim was won, not when it was attempted.
 * The one exception is the composer's text, which belongs to the operator and
 * is never sent on their behalf.
 */

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/* ------------------------------------------------------------------ lists -- */

/** Loads both halves of the inbox: the queue and the caller's own work. */
export async function loadInboxScreen(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    // A bookmarked supervisor lens is still validated by the server on every
    // read. The browser restores only the opaque membership reference; it
    // never restores a different session or an assumed directory entry.
    if (live.supervisorAgentId === null && uuid(context.state.route.params['agent'])) {
      live.supervisorAgentId = context.state.route.params['agent']!;
    }
    if (live.supervisorAgentId !== null) {
      live.conversations = LOADING;
      live.supervisorWorkload = LOADING;
      context.refresh();
      const [page, workload] = await Promise.all([
        live.conversationsApi.supervisorList(tenantId, live.supervisorAgentId, { ...live.inboxQuery, cursor: null }),
        live.conversationsApi.supervisorWorkload(tenantId, live.supervisorAgentId),
      ]);
      live.conversations = page.ok ? ready(page.data.items, context.now()) : failed(page.error);
      live.supervisorWorkload = fromResult(workload, context.now());
      live.inboxNextCursor = page.ok ? page.data.nextCursor : null;
      if (!page.ok) live.error = page.error;
      else if (!workload.ok) live.error = workload.error;
      context.refresh();
      return;
    }
    live.unassigned = LOADING;
    live.conversations = LOADING;
    context.refresh();

    const [unassigned, mine] = await Promise.all([
      live.conversationsApi.unassigned(tenantId, unassignedFilterProjection(live.inboxQuery)),
      live.conversationsApi.list(tenantId, live.inboxQuery),
    ]);
    const now = context.now();
    live.unassigned = fromResult(unassigned, now);
    live.conversations = mine.ok ? ready(mine.data.items, now) : failed(mine.error);
    live.inboxNextCursor = mine.ok ? mine.data.nextCursor : null;
    context.refresh();
    if (live.labels.status === 'idle') await loadMetadataCatalog(context);
    if (live.savedViews.status === 'idle') await loadSavedViews(context);
    if (live.people.status === 'idle' || live.teams.status === 'idle' || live.connections.status === 'idle' || live.campaigns.status === 'idle') {
      await loadInboxPickerCatalogues(context, tenantId);
    }
  });
}

function uuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Opens the protected agent picker; a 403 is displayed as such, never faked. */
export async function loadSupervisorAgents(context: LiveContext): Promise<void> {
  return forTenant(context, undefined, async (tenantId) => {
    context.live.supervisorAgents = LOADING;
    context.refresh();
    const result = await context.live.conversationsApi.supervisorAgents(tenantId);
    context.live.supervisorAgents = fromResult(result, context.now());
    if (!result.ok) context.live.error = result.error;
    context.refresh();
  });
}

/** Lists the selected agent's work under the signed-in supervisor's own RBAC. */
export async function loadSupervisorInbox(context: LiveContext, agentMembershipId: string): Promise<boolean> {
  if (!rowsOf(context.live.supervisorAgents).some((agent) => agent.membershipId === agentMembershipId)) return false;
  return forTenant(context, false, async (tenantId) => {
    context.live.conversations = LOADING;
    context.live.supervisorWorkload = LOADING;
    context.live.supervisorAgentId = agentMembershipId;
    context.state.inboxQueue = 'mine';
    context.state.route = { ...context.state.route, params: { ...context.state.route.params, agent: agentMembershipId } };
    context.refresh();
    const [result, workload] = await Promise.all([
      context.live.conversationsApi.supervisorList(tenantId, agentMembershipId, { ...context.live.inboxQuery, cursor: null }),
      context.live.conversationsApi.supervisorWorkload(tenantId, agentMembershipId),
    ]);
    context.live.conversations = result.ok ? ready(result.data.items, context.now()) : failed(result.error);
    context.live.supervisorWorkload = fromResult(workload, context.now());
    context.live.inboxNextCursor = result.ok ? result.data.nextCursor : null;
    if (!result.ok) context.live.error = result.error;
    else if (!workload.ok) context.live.error = workload.error;
    context.refresh();
    return result.ok;
  });
}

/**
 * Uses only server-provided labels for ID-backed Inbox filters. A browser must
 * never invite an operator to paste a membership, connection, label or campaign
 * UUID just to express a query.
 */
async function loadInboxPickerCatalogues(context: LiveContext, tenantId: string): Promise<void> {
  const { live } = context;
  const [people, teams, connections, campaigns] = await Promise.all([
    live.api.people(tenantId),
    live.api.teams(tenantId),
    live.channels.connections(tenantId),
    live.campaignsApi.list(tenantId),
  ]);
  const now = context.now();
  live.people = fromResult(people, now);
  live.teams = fromResult(teams, now);
  live.connections = fromResult(connections, now);
  live.campaigns = fromResult(campaigns, now);
  context.refresh();
}

/** Appends one cursor page without changing the filter URL or duplicating rows. */
export async function loadMoreInbox(context: LiveContext): Promise<void> {
  const cursor = context.live.inboxNextCursor;
  if (cursor === null || context.live.busy !== null) return;
  return forTenant(context, undefined, async (tenantId) => {
    context.live.busy = 'inbox-load-more';
    context.refresh();
    const result = context.live.supervisorAgentId === null
      ? await context.live.conversationsApi.list(tenantId, { ...context.live.inboxQuery, cursor })
      : await context.live.conversationsApi.supervisorList(tenantId, context.live.supervisorAgentId, { ...context.live.inboxQuery, cursor });
    context.live.busy = null;
    if (!result.ok) {
      context.live.error = result.error;
      context.refresh();
      return;
    }
    const existing = context.live.conversations.status === 'ready' ? context.live.conversations.value : [];
    const seen = new Set(existing.map((conversation) => conversation.id));
    context.live.conversations = ready([...existing, ...result.data.items.filter((conversation) => !seen.has(conversation.id))], context.now());
    context.live.inboxNextCursor = result.data.nextCursor;
    // A continuation is a transport position, never part of the persisted
    // operator query. Realtime therefore always re-reads its first page.
    context.live.inboxQuery = { ...context.live.inboxQuery, cursor: null };
    context.refresh();
  });
}


/* ---------------------------------------------------------------- reading -- */

/** Opens a conversation: the record, then its most recent page of messages. */
export async function openConversation(context: LiveContext, id: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    live.openConversationId = id;
    live.openConversation = LOADING;
    live.timeline = LOADING;
    live.timelineCursor = null;
    live.composer = '';
    // The note draft belongs to the conversation it was being written about.
    // Carrying it to the next thread is how an internal remark about one
    // customer ends up filed against another.
    live.noteDraft = '';
    live.editingNoteId = null;
    live.noteEdit = '';
    live.notes = LOADING;
    live.episodes = LOADING;
    live.lifecyclePanel = null;
    live.routingPanel = null;
    live.routingChoice = '';
    live.handoffNote = '';
    // The directory is not loaded here: it is a per-conversation list that goes
    // stale immediately, so it is fetched when a picker actually opens.
    live.assignees = { status: 'idle' };
    live.handoffs = LOADING;
    live.collaborators = LOADING;
    live.lostAccess = false;
    // The open conversation belongs in the URL: a reload, a back button or a
    // link pasted to a colleague should land on the same thread. `refresh`
    // syncs the address bar from the route.
    context.state.route = { ...context.state.route, conversationId: id };
    context.refresh();

    const conversation = await live.conversationsApi.read(tenantId, id);
    live.openConversation = fromResult(conversation, context.now());
    if (!conversation.ok) {
      // No record means no contents: the timeline carries the same refusal
      // rather than spinning forever beside an error.
      live.timeline = failed(conversation.error);
      live.openContact = { status: 'idle' };
      live.notes = failed(conversation.error);
      live.episodes = failed(conversation.error);
      live.handoffs = failed(conversation.error);
      live.collaborators = failed(conversation.error);
      context.refresh();
      return;
    }
    await Promise.all([
      loadTimeline(context, id),
      // The customer beside the conversation. A conversation nobody has written
      // to has no contact, and the panel says so rather than inventing one.
      loadOpenContact(context, conversation.data.contactId),
      loadNotes(context, id),
      loadEpisodes(context, id),
      loadRouting(context, id),
    ]);
    // Read last, and only once the contents are actually on screen: a cursor
    // moved before the messages arrived would mark as seen what a failed
    // timeline never showed anybody.
    // Supervisor inspection is observational. It never alters the selected
    // agent's cursor and it also avoids manufacturing a supervisor read side
    // effect merely from opening a read-only lens.
    if (live.supervisorAgentId === null) await markConversationRead(context, id);
  });
}

/**
 * Re-reads the open record in place.
 *
 * Deliberately does not blank it first: the thread header, the status pill and
 * the lifecycle controls would all flicker through a skeleton for a change that
 * usually moves one field. A failed re-read leaves the last good record
 * standing rather than replacing a working screen with an error somebody did
 * not ask for — the next action against a stale version is refused by the
 * server's fence anyway.
 */
export async function refreshOpenConversation(context: LiveContext, id: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const fresh = await live.conversationsApi.read(tenantId, id);
    if (fresh.ok) {
      live.openConversation = ready(fresh.data, context.now());
      context.refresh();
    }
  });
}

async function loadTimeline(context: LiveContext, id: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const page = await live.conversationsApi.timeline(tenantId, id, null);
    live.timeline = page.ok ? ready(page.data.messages, context.now()) : failed(page.error);
    live.timelineCursor = page.ok ? page.data.nextCursor : null;
    context.refresh();
  });
}

/**
 * Loads the page before the one on screen.
 *
 * Prepended, not replaced: reading further back into a conversation must not
 * take away what is already visible.
 */
export async function loadOlderMessages(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const id = live.openConversationId;
    const cursor = live.timelineCursor;
    if (id === null || cursor === null || live.timeline.status !== 'ready') {
      // Nothing open, nothing older, or nothing on screen to prepend to.
      return;
    }
    const existing = live.timeline.value;
    live.busy = 'load-older';
    context.refresh();

    const page = await live.conversationsApi.timeline(tenantId, id, cursor);
    live.busy = null;
    if (!page.ok) {
      live.error = page.error;
      context.refresh();
      return;
    }
    live.timeline = ready([...page.data.messages, ...existing], context.now());
    live.timelineCursor = page.data.nextCursor;
    context.refresh();
  });
}

/* --------------------------------------------------------------- mutating -- */

/**
 * Claims a conversation at the version on the card in front of the agent.
 *
 * A conflict is not an error to apologise for: somebody else got there first,
 * which is the system working. The queue is re-read so the card disappears.
 */
export async function claimConversation(
  context: LiveContext,
  id: string,
  version: number,
): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    live.busy = `claim:${id}`;
    live.error = null;
    context.refresh();

    const result = await live.conversationsApi.claim(tenantId, id, version);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(
        context.state,
        claimFailureText(context, result.error),
        result.error.code === 'conversation_version_conflict' ? 'warning' : 'danger',
      );
      await refreshInboxLists(context);
      return false;
    }
    live.openConversation = ready(result.data, context.now());
    live.openConversationId = result.data.id;
    await Promise.all([
      refreshInboxLists(context),
      loadTimeline(context, result.data.id),
      loadOpenContact(context, result.data.contactId),
    ]);
    pushToast(context.state, t(context, 'المحادثة الآن لديك.', 'The conversation is yours.'));
    return true;
  });
}

function claimFailureText(context: LiveContext, error: ApiError): string {
  if (error.code === 'conversation_version_conflict') {
    return t(
      context,
      'زميل آخر استلمها قبلك. حُدِّثت القائمة.',
      'A colleague claimed it first. The list has been refreshed.',
    );
  }
  return error.message;
}

/**
 * Sends what is in the composer.
 *
 * The reply is addressed to the **conversation**; the recipient comes from the
 * server's record. The composer is cleared only after the command exists, so a
 * failed send does not lose what the agent wrote.
 */
export async function sendReply(context: LiveContext): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    const id = live.openConversationId;
    const text = live.composer.trim();
    if (id === null || text === '') {
      // Nothing open, or nothing written. Sending blank is not a send.
      return false;
    }
    live.busy = 'send-reply';
    live.error = null;
    context.refresh();

    const result = await live.conversationsApi.reply(tenantId, id, {
      text,
      clientMessageId: context.newKey(),
    });
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      // The composer is deliberately kept: retyping a reply because the network
      // blinked is the worst small thing a messaging tool can do to somebody.
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    live.composer = '';
    await loadTimeline(context, id);
    return true;
  });
}

/* --------------------------------------------------------------- realtime -- */

export interface RealtimeWiring {
  readonly open: EventSourceFactory;
  readonly baseUrl: string;
}

/**
 * Opens the stream for the current company.
 *
 * Every event triggers a re-read rather than a local patch — see this module's
 * note. A reset reloads the whole screen, because after a permission change
 * both what was delivered and what was skipped were chosen under rules that no
 * longer apply.
 */
export function startRealtime(context: LiveContext, wiring: RealtimeWiring): void {
  const { live } = context;
  const tenantId = currentTenantId(live);
  if (tenantId === null || live.subscription !== null) {
    return;
  }
  live.subscription = subscribe({
    baseUrl: wiring.baseUrl,
    tenantId,
    open: wiring.open,
    handlers: {
      onEvent: (event) => {
        void applyRealtimeEvent(context, event);
      },
      onReset: (reason) => {
        live.realtime = { status: 'stale', reason, retryAt: context.now() };
        void loadInboxScreen(context);
      },
      onDisconnect: (reason, willRetry) => {
        if (!willRetry) {
          // The stream closed itself and will not come back. The screen says
          // so rather than looking quiet.
          live.subscription = null;
          live.realtime = { status: 'stopped', reason };
          context.refresh();
          return;
        }
        // `EventSource` reconnects on its own, using the floor the server sent.
        // What is on screen is a snapshot until it does, and that is what this
        // says.
        live.realtime = { status: 'stale', reason, retryAt: context.now() };
        context.refresh();
      },
    },
  });
  live.realtime = { status: 'live', since: context.now() };
  context.refresh();
}

export function stopRealtime(context: LiveContext): void {
  const { live } = context;
  live.subscription?.close();
  live.subscription = null;
  live.realtime = { status: 'idle' };
}

/**
 * Applies one event by re-reading what it touched.
 *
 * The open conversation is refreshed only when the event is about it, so an
 * agent reading one thread is not interrupted by traffic in another.
 */
export async function applyRealtimeEvent(
  context: LiveContext,
  event: RealtimeEvent,
): Promise<void> {
  const { live } = context;
  live.realtime = { status: 'live', since: context.now() };
  const tasks: Promise<unknown>[] = [refreshInboxLists(context)];
  // Assignment changes can remove the selected agent from the event scope. A
  // state/routing event delivered inside the supervisor's readable scope is
  // therefore the narrow safe invalidation set: message-only events leave the
  // current workload unchanged, while any live-work mutation re-reads it.
  if (
    live.supervisorAgentId !== null &&
    (event.type === 'conversation.state' || event.type === 'conversation.assigned' || event.type === 'conversation.routing')
  ) {
    tasks.push(refreshSupervisorWorkload(context));
  }
  if (event.scope.conversationId === live.openConversationId) {
    tasks.push(loadTimeline(context, event.scope.conversationId));
    if (event.type === 'conversation.handoff') {
      // The offers moved; the record did not. Re-reading the whole conversation
      // for an offer somebody made would be a request for a banner.
      tasks.push(loadRouting(context, event.scope.conversationId));
    }
    if (
      event.type === 'conversation.state' ||
      event.type === 'conversation.assigned' ||
      event.type === 'conversation.routing'
    ) {
      // The record moved, not only its contents: a colleague resolved it, a
      // wake fired, or it was assigned elsewhere. Re-read it, because the
      // lifecycle controls on screen are drawn from the status and the version,
      // and acting on a stale pair is exactly what the fence exists to refuse.
      tasks.push(refreshOpenConversation(context, event.scope.conversationId));
    }
  }
  await Promise.all(tasks);
}

/** Refresh only the selected workload projection after relevant realtime work. */
export async function refreshSupervisorWorkload(context: LiveContext): Promise<void> {
  const agentId = context.live.supervisorAgentId;
  if (agentId === null) return;
  return forTenant(context, undefined, async (tenantId) => {
    const result = await context.live.conversationsApi.supervisorWorkload(tenantId, agentId);
    if (result.ok) context.live.supervisorWorkload = ready(result.data, context.now());
    else context.live.error = result.error;
    context.refresh();
  });
}
