import type { ApiError } from '../api/client.js';
import type { TransitionCommand } from '../api/conversations.js';
import { pushToast } from '../state.js';
import type { LiveContext } from './actions.js';
import { refreshInboxLists } from './inbox-lists.js';
import { failed, forTenant, fromResult, LOADING, ready } from './store.js';

/**
 * The lifecycle, the notes and the read cursor, from the browser.
 *
 * Three things that look unrelated and share one rule: **none of them may
 * pretend.** A transition the server refused is not applied locally; a note is
 * never sent anywhere near the composer that reaches a customer; and marking a
 * conversation read is this person's bookkeeping and is never shown as a
 * receipt.
 *
 * Every transition carries the version the agent saw. Losing that race is
 * reported as a colleague having moved first, which is what it is, rather than
 * as an error the agent could have avoided.
 */

function t(context: LiveContext, ar: string, en: string): string {
  return context.state.lang === 'ar' ? ar : en;
}

/**
 * The refusals the lifecycle table makes, in the operator's words.
 *
 * Each one is a fact about where the conversation actually is, not a validation
 * error: the agent did nothing wrong, the conversation moved.
 */
export function transitionRefusal(context: LiveContext, error: ApiError): string {
  const messages: Readonly<Record<string, [string, string]>> = {
    conversation_version_conflict: [
      'تغيّرت المحادثة أثناء نظرك إليها. أُعيد تحميلها.',
      'The conversation changed while you were looking at it. It has been reloaded.',
    ],
    already_open: ['المحادثة مفتوحة أصلًا.', 'This conversation is already open.'],
    not_resolved: [
      'تُؤرشَف المحادثات المُغلقة فقط.',
      'Only a resolved conversation can be archived.',
    ],
    not_waiting_on_a_customer: [
      'المحادثة ليست مفتوحة، فلا أحد ننتظره.',
      'This conversation is not open, so there is nobody to wait for.',
    ],
    archived_conversation_is_immutable: [
      'المحادثة مؤرشفة. سجلّها محفوظ كما هو، ورسالة جديدة من العميل تفتح محادثة أخرى.',
      'This conversation is archived. Its history is kept as it was, and a new message from the customer opens another one.',
    ],
    wake_time_in_the_past: ['اختر وقتًا في المستقبل.', 'Choose a time in the future.'],
    wake_time_too_far_ahead: [
      'اختر وقتًا خلال سنة من الآن.',
      'Choose a time within the next year.',
    ],
    unknown_timezone: [
      'المنطقة الزمنية غير معروفة لهذا الخادم.',
      'That is not a timezone this server recognises.',
    ],
  };
  const entry = messages[error.code];
  return entry === undefined ? error.message : t(context, entry[0], entry[1]);
}

/**
 * Moves the open conversation.
 *
 * The version comes from the record on screen. On a conflict the record is
 * re-read rather than patched, because the answer to "somebody moved this" is
 * what the server now says, not what we hoped.
 */
export async function transitionConversation(
  context: LiveContext,
  command: TransitionCommand,
): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    const open = live.openConversation;
    if (open.status !== 'ready') {
      return false;
    }
    const id = open.value.id;
    live.busy = `lifecycle:${id}`;
    live.error = null;
    context.refresh();

    const result = await live.conversationsApi.transition(tenantId, id, open.value.version, command);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(
        context.state,
        transitionRefusal(context, result.error),
        result.error.code === 'conversation_version_conflict' ? 'warning' : 'danger',
      );
      // Re-read rather than guess. A refusal usually means the state on screen
      // is out of date, and showing the stale one beside the refusal is worse
      // than showing neither.
      const fresh = await live.conversationsApi.read(tenantId, id);
      live.openConversation = fromResult(fresh, context.now());
      context.refresh();
      return false;
    }
    live.openConversation = ready(result.data, context.now());
    live.lifecyclePanel = null;
    pushToast(context.state, transitionConfirmation(context, command));
    await Promise.all([loadEpisodes(context, id), refreshInboxLists(context)]);
    return true;
  });
}

function transitionConfirmation(context: LiveContext, command: TransitionCommand): string {
  if (command.command === 'wait') {
    return t(context, 'سُجّل أنك بانتظار العميل.', 'Recorded: waiting for the customer.');
  }
  if (command.command === 'snooze') {
    return t(context, 'أُجّلت المحادثة.', 'The conversation is snoozed.');
  }
  if (command.command === 'resolve') {
    return t(context, 'أُغلقت المحادثة.', 'The conversation is resolved.');
  }
  if (command.command === 'reopen') {
    return t(context, 'أُعيد فتح المحادثة بحلقة تقارير جديدة.', 'Reopened, in a new reporting episode.');
  }
  return t(context, 'أُرشِفت المحادثة.', 'The conversation is archived.');
}

/* ------------------------------------------------------------------ notes -- */

export async function loadNotes(context: LiveContext, conversationId: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    live.notes = LOADING;
    context.refresh();
    const result = await live.conversationsApi.notes(tenantId, conversationId);
    live.notes = result.ok ? ready(result.data, context.now()) : failed(result.error);
    context.refresh();
  });
}

export async function loadEpisodes(context: LiveContext, conversationId: string): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const result = await live.conversationsApi.episodes(tenantId, conversationId);
    live.episodes = result.ok ? ready(result.data, context.now()) : failed(result.error);
    context.refresh();
  });
}

/**
 * Writes what is in the note draft.
 *
 * Cleared only after the note exists, for the same reason the composer is: a
 * failed write must not lose what somebody typed.
 */
export async function addNote(context: LiveContext): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    const id = live.openConversationId;
    const body = live.noteDraft.trim();
    if (id === null || body === '') {
      return false;
    }
    live.busy = `note:${id}`;
    live.error = null;
    context.refresh();

    const result = await live.conversationsApi.addNote(tenantId, id, body);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, result.error.message, 'danger');
      context.refresh();
      return false;
    }
    live.noteDraft = '';
    pushToast(context.state, t(context, 'أُضيفت الملاحظة.', 'Note added.'));
    await loadNotes(context, id);
    return true;
  });
}

/**
 * Corrects a note that is already written.
 *
 * An edit rather than a delete-and-retype: the note keeps its place and its
 * original time, and the row is marked as edited so nobody reads a corrected
 * remark as the one that was there at the time.
 */
export async function editNote(context: LiveContext, noteId: string): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    const id = live.openConversationId;
    const body = live.noteEdit.trim();
    if (id === null || body === '') {
      return false;
    }
    live.busy = `note:${noteId}`;
    live.error = null;
    context.refresh();

    const result = await live.conversationsApi.editNote(tenantId, noteId, body);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, noteRefusal(context, result.error), 'danger');
      context.refresh();
      return false;
    }
    live.editingNoteId = null;
    live.noteEdit = '';
    pushToast(context.state, t(context, 'حُدّثت الملاحظة.', 'Note updated.'));
    await loadNotes(context, id);
    return true;
  });
}

export async function deleteNote(context: LiveContext, noteId: string): Promise<boolean> {
  const { live } = context;
  return forTenant(context, false, async (tenantId) => {
    const id = live.openConversationId;
    if (id === null) {
      return false;
    }
    live.busy = `note:${noteId}`;
    live.error = null;
    context.refresh();

    const result = await live.conversationsApi.deleteNote(tenantId, noteId);
    live.busy = null;
    if (!result.ok) {
      live.error = result.error;
      pushToast(context.state, noteRefusal(context, result.error), 'danger');
      context.refresh();
      return false;
    }
    // Marked, not gone. The list is re-read so the marker is what shows.
    pushToast(context.state, t(context, 'حُذفت الملاحظة.', 'Note deleted.'));
    await loadNotes(context, id);
    return true;
  });
}

/** The one refusal a note write makes that is worth saying in our own words. */
function noteRefusal(context: LiveContext, error: ApiError): string {
  return error.code === 'not_the_author'
    ? t(
        context,
        'يمكن لكاتب الملاحظة وحده تعديلها أو حذفها.',
        'Only the person who wrote a note can change it.',
      )
    : error.message;
}

/* ------------------------------------------------------------------- read -- */

/**
 * Moves this person's read cursor.
 *
 * Deliberately quiet: no toast, no event, nothing on the customer's side. The
 * only visible effect is that the row stops being bold in this person's list,
 * which is the entire point of a cursor that belongs to one person.
 */
export async function markConversationRead(
  context: LiveContext,
  conversationId: string,
): Promise<void> {
  const { live } = context;
  return forTenant(context, undefined, async (tenantId) => {
    const result = await live.conversationsApi.markRead(tenantId, conversationId);
    if (result.ok) {
      await refreshInboxLists(context);
    }
  });
}
