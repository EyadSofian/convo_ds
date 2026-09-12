import type { ApiError } from '../api/client.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { loadOpenContact } from './contact-actions.js';
import { refreshInboxLists } from './inbox-lists.js';
import { loadEpisodes, loadNotes, markConversationRead } from './lifecycle-actions.js';
import { loadRouting } from './routing-actions.js';
import { subscribe } from './realtime.js';
import type { EventSourceFactory, RealtimeEvent } from './realtime.js';
import { currentTenantId, failed, forTenant, fromResult, LOADING, ready } from './store.js';
import { loadMetadataCatalog } from './metadata-catalog.js';

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
    live.unassigned = LOADING;
    live.conversations = LOADING;
    context.refresh();

    const [unassigned, mine] = await Promise.all([
      live.conversationsApi.unassigned(tenantId, live.inboxFilters),
      live.conversationsApi.list(tenantId, 'mine', live.inboxFilters),
    ]);
    const now = context.now();
    live.unassigned = fromResult(unassigned, now);
    live.conversations = fromResult(mine, now);
    context.refresh();
    if (live.labels.status === 'idle') await loadMetadataCatalog(context);
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
    await markConversationRead(context, id);
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
