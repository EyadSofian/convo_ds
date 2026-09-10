import type { ApiError } from '../api/client.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { refreshInboxLists } from './inbox-lists.js';
import { failed, forTenant, fromResult, LOADING, ready } from './store.js';

/**
 * Moving a conversation between people, from the browser.
 *
 * Three acts with three permissions, and the screen keeps them apart because
 * the server does (ADR-0017): a **claim** takes work nobody holds, an
 * **assignment** puts work on a named desk, and a **handoff** asks a colleague
 * who may decline.
 *
 * Two rules shape every function here.
 *
 * **The directory is a suggestion, never an authorization.** The list is loaded
 * when the picker opens and is stale the moment after; the server re-derives the
 * target's eligibility inside the write, so a refusal is normal and is shown
 * beside the control that caused it rather than treated as a bug.
 *
 * **Nothing is shown as done before the server says so.** Every mutation carries
 * the version the operator saw, stays busy until the response commits, and
 * re-reads the record rather than patching it — a routing decision is exactly
 * the kind of state two people change at once.
 */

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/**
 * The refusals this surface makes, in the operator's words.
 *
 * Each is a fact about the world rather than a mistake the operator made: the
 * conversation moved, the colleague's access changed, somebody answered first.
 * The `request_id` is appended by the caller so a refusal can be reported.
 */
export function routingRefusal(context: LiveContext, error: ApiError): string {
  const messages: Readonly<Record<string, [string, string]>> = {
    conversation_version_conflict: [
      'تغيّرت المحادثة أثناء نظرك إليها. أُعيد تحميلها.',
      'The conversation changed while you were looking at it. It has been reloaded.',
    ],
    assignee_not_eligible: [
      'لم يعد بإمكان هذا الزميل العمل على هذه المحادثة. ربما تغيّرت صلاحياته.',
      'That colleague can no longer work this conversation. Their access may have changed.',
    ],
    handoff_already_pending: [
      'سبق أن طُلب من زميل استلامها.',
      'Somebody has already been asked to take this conversation.',
    ],
    handoff_not_pending: ['أُجيب على هذا الطلب بالفعل.', 'This request has already been answered.'],
    handoff_expired: ['انتهت مهلة هذا الطلب.', 'This request ran out of time.'],
    handoff_superseded: [
      'انتقلت المحادثة إلى شخص آخر بعد إرسال الطلب.',
      'This conversation moved to somebody else after the request was made.',
    ],
    handoff_to_self: [
      'الطلب يُوجَّه إلى زميل، وهذا موجّه إليك.',
      'A handoff is an offer to somebody else. This one is addressed to you.',
    ],
    not_the_recipient: [
      'يجيب على الطلب من وُجّه إليه وحده.',
      'Only the person who was asked can answer this request.',
    ],
    not_the_requester: [
      'يسحب الطلب من أرسله، أو من يملك إعادة الإسناد.',
      'Only the person who made this request, or somebody who can reassign, may withdraw it.',
    ],
    handoff_expiry_too_soon: [
      'امنح زميلك خمس دقائق على الأقل.',
      'Give your colleague at least five minutes to answer.',
    ],
    handoff_expiry_too_far: [
      'يظل الطلب قائمًا سبعة أيام على الأكثر.',
      'A request can stand for at most seven days.',
    ],
    permission_denied: [
      'دورك لا يسمح بإعادة توجيه العمل.',
      'Your role does not allow routing work.',
    ],
  };
  const entry = messages[error.code];
  const text = entry === undefined ? error.message : t(context, entry[0], entry[1]);
  // The request id travels with every refusal: without it, "it failed" is not
  // something anybody can look up afterwards.
  return error.requestId === null ? text : `${text} (${error.requestId})`;
}

/**
 * Runs a routing mutation and keeps the screen honest while it does.
 *
 * One wrapper rather than the same eight lines in six places: mark busy, clear
 * the last error, call, and on a refusal put the server's own words beside the
 * control. Nothing here writes an optimistic result — a routing change that
 * appeared before the server agreed would be a claim about somebody else's work.
 */
async function mutate<T>(
  context: LiveContext,
  key: string,
  call: (tenantId: string) => Promise<{ ok: true; data: T } | { ok: false; error: ApiError }>,
  onSuccess: (value: T) => Promise<void> | void,
  confirmation: string,
): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    live.busy = key;
    live.error = null;
    context.refresh();

    const result = await call(tenantId);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, routingRefusal(context, result.error), 'danger');
      context.refresh();
      return false;
    }
    await onSuccess(result.data);
    pushToast(context.state, confirmation);
    context.refresh();
    return true;
  });
}

/* --------------------------------------------------------------- loading -- */

/** Loads everything the routing controls need for the open conversation. */
export async function loadRouting(context: LiveContext, conversationId: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const [handoffs, collaborators] = await Promise.all([
      live.conversationsApi.handoffs(tenantId, conversationId),
      live.conversationsApi.collaborators(tenantId, conversationId),
    ]);
    const now = context.now();
    // A failure to read them is not a failure to read the conversation: the
    // thread stays usable and only these sections say they could not load.
    live.handoffs = fromResult(handoffs, now);
    live.collaborators = fromResult(collaborators, now);
    context.refresh();
  });
}

/**
 * Loads the people who could take this conversation.
 *
 * Only when the picker opens. The list is per conversation, so loading it for
 * every thread somebody glances at would be a request per glance — and it would
 * be stale by the time anybody pressed anything anyway.
 */
export async function loadAssignees(context: LiveContext): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const id = live.openConversationId;
    if (id === null) {
      return;
    }
    live.assignees = LOADING;
    context.refresh();
    const result = await live.conversationsApi.assignableAgents(tenantId, id);
    live.assignees = result.ok ? ready(result.data, context.now()) : failed(result.error);
    context.refresh();
  });
}

/* -------------------------------------------------------------- mutating -- */

/** Puts the conversation on a named desk, or takes it off every desk. */
export async function assignConversation(
  context: LiveContext,
  membershipId: string | null,
): Promise<boolean> {
  const { live } = context;
  const open = live.openConversation;
  // `null` is the real unassign; `''` is a picker nobody chose from. The
  // confirm button is disabled for the second, but a disabled attribute is a
  // hint and not a guard — the empty string must never reach the wire.
  if (open.status !== 'ready' || membershipId === '') {
    return false;
  }
  const conversation = open.value;
  return mutate(
    context,
    `routing:${conversation.id}`,
    (tenantId) =>
      live.conversationsApi.assign(tenantId, conversation.id, conversation.version, membershipId),
    async (record) => {
      live.openConversation = ready(record, context.now());
      live.routingPanel = null;
      live.routingChoice = '';
      await refreshInboxLists(context);
    },
    membershipId === null
      ? t(context, 'رُفع الإسناد.', 'Taken off every desk.')
      : t(context, 'أُسندت المحادثة.', 'Assigned.'),
  );
}

/** Offers the conversation to a named colleague. */
export async function requestHandoff(context: LiveContext, membershipId: string): Promise<boolean> {
  const { live } = context;
  const id = live.openConversationId;
  const open = live.openConversation;
  if (id === null || membershipId === '' || open.status !== 'ready') {
    return false;
  }
  const note = live.handoffNote.trim();
  return mutate(
    context,
    `routing:${id}`,
    (tenantId) =>
      live.conversationsApi.requestHandoff(tenantId, id, {
        version: open.value.version,
        toMembershipId: membershipId,
        note: note === '' ? null : note,
      }),
    async () => {
      live.routingPanel = null;
      live.routingChoice = '';
      live.handoffNote = '';
      await loadRouting(context, id);
    },
    t(context, 'أُرسل الطلب. المحادثة ما زالت لديك حتى يوافق.', 'Asked. It stays yours until they accept.'),
  );
}

/** Answers or withdraws an offer. */
export async function settleHandoff(
  context: LiveContext,
  handoffId: string,
  action: 'accept' | 'decline' | 'cancel',
): Promise<boolean> {
  const { live } = context;
  const id = live.openConversationId;
  if (id === null) {
    return false;
  }
  return mutate(
    context,
    `handoff:${handoffId}`,
    (tenantId) => live.conversationsApi.settleHandoff(tenantId, handoffId, action),
    async () => {
      await Promise.all([loadRouting(context, id), reloadConversation(context, id)]);
      await refreshInboxLists(context);
    },
    action === 'accept'
      ? t(context, 'استلمت المحادثة.', 'You have taken the conversation.')
      : action === 'decline'
        ? t(context, 'اعتذرت عن الطلب.', 'You declined the request.')
        : t(context, 'سُحب الطلب.', 'Request withdrawn.'),
  );
}

export async function setPriority(context: LiveContext, priority: string): Promise<boolean> {
  const { live } = context;
  const open = live.openConversation;
  if (open.status !== 'ready' || open.value.priority === priority) {
    return false;
  }
  const conversation = open.value;
  return mutate(
    context,
    `routing:${conversation.id}`,
    (tenantId) =>
      live.conversationsApi.setPriority(tenantId, conversation.id, conversation.version, priority),
    async (record) => {
      live.openConversation = ready(record, context.now());
      live.routingPanel = null;
      await refreshInboxLists(context);
    },
    t(context, 'تغيّرت الأولوية.', 'Priority changed.'),
  );
}

/** Invites somebody to help, or ends that invitation. */
export async function setCollaborator(
  context: LiveContext,
  membershipId: string,
  present: boolean,
): Promise<boolean> {
  const { live } = context;
  const open = live.openConversation;
  if (open.status !== 'ready' || membershipId === '') {
    return false;
  }
  const conversation = open.value;
  return mutate(
    context,
    `collaborator:${membershipId}`,
    (tenantId) =>
      present
        ? live.conversationsApi.addCollaborator(
            tenantId,
            conversation.id,
            conversation.version,
            membershipId,
          )
        : live.conversationsApi.removeCollaborator(
            tenantId,
            conversation.id,
            conversation.version,
            membershipId,
          ),
    async (rows) => {
      live.collaborators = ready(rows, context.now());
      live.routingChoice = '';
      // The version moved, so the record has to be re-read before the next
      // fenced action is attempted with it.
      await reloadConversation(context, conversation.id);
    },
    present
      ? t(context, 'أُضيف الزميل.', 'Invited.')
      : t(context, 'انتهت مشاركة الزميل.', 'Invitation ended.'),
  );
}

/**
 * Re-reads the record after a routing change.
 *
 * A permission loss is a real answer here — accepting a handoff can move a
 * conversation *away* from somebody, and a supervisor can reassign one out from
 * under the person reading it. When the re-read is refused the screen clears the
 * thread rather than leaving another agent's timeline standing from cache.
 */
async function reloadConversation(context: LiveContext, conversationId: string): Promise<void> {
  const { live } = context;
  const had = live.openConversation.status === 'ready';
  return forTenant(context, undefined, async (tenantId) => {
    const fresh = await live.conversationsApi.read(tenantId, conversationId);
    live.openConversation = fromResult(fresh, context.now());
    if (!fresh.ok) {
      live.lostAccess = had;
      live.timeline = failed(fresh.error);
      live.notes = failed(fresh.error);
      live.collaborators = failed(fresh.error);
      live.handoffs = failed(fresh.error);
      live.composer = '';
      live.noteDraft = '';
    }
    context.refresh();
  });
}
