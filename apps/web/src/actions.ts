import type { ChannelKind, ConversationStatus, Priority, SavedView, SortOrder } from './data';
import type { DateWindow, MultiKey, QueueSegment } from './filters';
import {
  clearFilters,
  createFilter,
  criteriaFromFilter,
  DATE_VALUES,
  filterFromView,
  MULTI_KEYS,
  QUEUE_SEGMENTS,
  SORT_VALUES,
  toggleFilterValue,
} from './filters';
import { minutesUntil } from './format';
import { canAssignOthers } from './permissions';
import { conversationAccess } from './permissions';
import type { ScreenId } from './router';
import { SCREENS } from './router';
import type { AppState, ComposerTab, PreviewState } from './state';
import {
  appendTimeline,
  clampListWidth,
  currentActor,
  findConversation,
  nextId,
  patchConversation,
  PREVIEW_STATES,
  pushToast,
  readDraft,
  VIEWABLE_ROLES,
  writeDraft,
} from './state';

/**
 * Every interactive control in the UI carries `data-act` (+ optional `data-arg`)
 * and is dispatched through this table by one delegated listener in app.ts.
 * Handlers mutate state and never touch the DOM, which is what makes them
 * directly testable without a render.
 */

export interface ActionContext {
  readonly state: AppState;
  /** Applies a route change and re-renders. */
  /**
   * `conversationId` is required, not optional: every call site already passes
   * it, and an optional parameter invented an `undefined` case no caller could
   * produce — an unreachable branch in the mount's navigate handler.
   */
  navigate(screen: ScreenId, conversationId: string | null): void;
  /** Re-renders from current state. */
  refresh(): void;
}

export type ActionHandler = (context: ActionContext, arg: string) => void;

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** The conversation the thread column is showing, if any. */
export function selectedId(state: AppState): string | null {
  return state.route.conversationId;
}

function closeTransient(state: AppState): void {
  state.openMenu = null;
}

function markRead(state: AppState, id: string): void {
  patchConversation(state, id, { unreadCount: 0 });
}

const nav: ActionHandler = (context, arg) => {
  if (!isMember(SCREENS, arg)) return;
  closeTransient(context.state);
  context.state.listOpen = false;
  if (!context.state.openTabs.includes(arg)) {
    context.state.openTabs = [...context.state.openTabs, arg];
  }
  context.navigate(arg, arg === 'inbox' ? selectedId(context.state) : null);
};

/**
 * Where to land after closing the tab that was at `closedIndex`.
 *
 * The neighbour to its left, or the first remaining tab. Exported and total so
 * the empty case is exercised directly: `closeTab` refuses to close the last
 * tab, so an empty list is unreachable through the UI, but a function that
 * indexes an array should still say what it does when there is nothing there.
 */
export function nextTabAfterClose(remaining: readonly ScreenId[], closedIndex: number): ScreenId {
  return remaining[Math.max(0, closedIndex - 1)] ?? 'inbox';
}

const closeTab: ActionHandler = (context, arg) => {
  if (!isMember(SCREENS, arg) || context.state.openTabs.length === 1) return;
  const index = context.state.openTabs.indexOf(arg);
  if (index === -1) return;
  context.state.openTabs = context.state.openTabs.filter((screen) => screen !== arg);
  if (context.state.route.screen !== arg) {
    context.refresh();
    return;
  }
  const next = nextTabAfterClose(context.state.openTabs, index);
  context.navigate(next, next === 'inbox' ? selectedId(context.state) : null);
};

const toggleTheme: ActionHandler = (context) => {
  context.state.theme = context.state.theme === 'light' ? 'dark' : 'light';
  context.refresh();
};

const openConversation: ActionHandler = (context, arg) => {
  const state = context.state;
  const conversation = findConversation(state, arg);
  if (conversation === undefined) return;
  closeTransient(state);
  state.listOpen = false;
  // Reading advances *this* user's cursor only (business-rules §4); a queue card
  // has no readable content, so its unread state is untouched.
  if (conversationAccess(currentActor(state), conversation) === 'full') markRead(state, arg);
  context.navigate('inbox', arg);
};

const setQueue: ActionHandler = (context, arg) => {
  if (!isMember(QUEUE_SEGMENTS, arg)) return;
  context.state.filter = { ...context.state.filter, queue: arg as QueueSegment };
  context.state.activeViewId = null;
  context.refresh();
};

const setSort: ActionHandler = (context, arg) => {
  if (!isMember(SORT_VALUES, arg)) return;
  context.state.filter = { ...context.state.filter, sort: arg as SortOrder };
  context.state.openMenu = null;
  context.refresh();
};

const setSearch: ActionHandler = (context, arg) => {
  context.state.filter = { ...context.state.filter, query: arg };
  context.refresh();
};

const setDate: ActionHandler = (context, arg) => {
  if (!isMember(DATE_VALUES, arg)) return;
  context.state.filter = { ...context.state.filter, date: arg as DateWindow };
  context.state.activeViewId = null;
  context.refresh();
};

/** `arg` is `"<multiKey>:<value>"`, e.g. `"channels:whatsapp"`. */
const toggleFilter: ActionHandler = (context, arg) => {
  const separator = arg.indexOf(':');
  if (separator === -1) return;
  const key = arg.slice(0, separator);
  const value = arg.slice(separator + 1);
  if (!isMember(MULTI_KEYS, key)) return;
  context.state.filter = toggleFilterValue(context.state.filter, key as MultiKey, value);
  context.state.activeViewId = null;
  context.refresh();
};

const clearAll: ActionHandler = (context) => {
  context.state.filter = clearFilters(context.state.filter);
  context.state.activeViewId = null;
  context.refresh();
};

const resetInbox: ActionHandler = (context) => {
  context.state.filter = createFilter();
  context.state.activeViewId = null;
  context.state.preview = 'ready';
  context.refresh();
};

const applyView: ActionHandler = (context, arg) => {
  const state = context.state;
  const view = state.views.find((entry) => entry.id === arg);
  if (view === undefined) return;
  state.filter = filterFromView(view, state.filter);
  state.activeViewId = view.id;
  state.listOpen = false;
  context.refresh();
};

const toggleMenu: ActionHandler = (context, arg) => {
  context.state.openMenu = context.state.openMenu === arg ? null : arg;
  context.refresh();
};

const closeMenu: ActionHandler = (context) => {
  context.state.openMenu = null;
  context.refresh();
};

const toggleGroup: ActionHandler = (context, arg) => {
  const collapsed = context.state.collapsedGroups;
  context.state.collapsedGroups = collapsed.includes(arg)
    ? collapsed.filter((entry) => entry !== arg)
    : [...collapsed, arg];
  context.refresh();
};

/**
 * Opening one side zone leaves focus mode. Nothing else force-closes the other
 * zone: CSS promotes a zone to an inline column only when the viewport can
 * seat the open combination, and otherwise renders it as a drawer, so the
 * timeline never drops below 640px whatever the operator opens.
 */
const togglePanel: ActionHandler = (context) => {
  context.state.panelOpen = !context.state.panelOpen;
  if (context.state.panelOpen) context.state.focusMode = false;
  context.refresh();
};

const toggleList: ActionHandler = (context) => {
  context.state.listOpen = !context.state.listOpen;
  context.refresh();
};

const toggleSidebar: ActionHandler = (context) => {
  const open = !context.state.viewsOpen;
  context.state.viewsOpen = open;
  if (open) context.state.focusMode = false;
  context.refresh();
};

/** Closes whichever overlay zones are open. Bound to Escape and to the scrim. */
const closeOverlays: ActionHandler = (context, arg) => {
  const state = context.state;
  if (arg === 'views' || arg === '') state.viewsOpen = false;
  if (arg === 'panel' || arg === '') state.panelOpen = false;
  if (arg === 'list' || arg === '') state.listOpen = false;
  context.refresh();
};

/** Focus mode: both optional side zones closed, timeline at maximum width. */
const toggleFocus: ActionHandler = (context) => {
  const next = !context.state.focusMode;
  context.state.focusMode = next;
  if (next) {
    context.state.viewsOpen = false;
    context.state.panelOpen = false;
  }
  context.refresh();
};

/**
 * Queue-list resize. The argument is the proposed width in CSS pixels; the
 * clamp lives in state.ts so the keyboard step and the pointer drag cannot
 * disagree about the bounds.
 */
const resizeListStep: ActionHandler = (context, arg) => {
  const step = arg === 'inc' ? 8 : arg === 'dec' ? -8 : 0;
  if (step === 0) return;
  const next = clampListWidth(context.state.listWidth + step);
  if (next === context.state.listWidth) return;
  context.state.listWidth = next;
  context.refresh();
};

const resizeList: ActionHandler = (context, arg) => {
  const proposed = Number.parseFloat(arg);
  if (Number.isNaN(proposed)) return;
  const next = clampListWidth(proposed);
  if (next === context.state.listWidth) return;
  context.state.listWidth = next;
  context.refresh();
};

const setLang: ActionHandler = (context, arg) => {
  context.state.lang = arg === 'en' ? 'en' : 'ar';
  context.refresh();
};

const setPreview: ActionHandler = (context, arg) => {
  if (!isMember(PREVIEW_STATES, arg)) return;
  context.state.preview = arg as PreviewState;
  context.refresh();
};

const setRole: ActionHandler = (context, arg) => {
  if (!isMember(VIEWABLE_ROLES, arg)) return;
  context.state.role = arg;
  context.state.openMenu = null;
  context.refresh();
};

const setComposerTab: ActionHandler = (context, arg) => {
  context.state.composerTab = arg === 'note' ? 'note' : 'reply';
  context.refresh();
};

const composerInput: ActionHandler = (context, arg) => {
  const id = selectedId(context.state);
  if (id === null) return;
  writeDraft(context.state, id, context.state.composerTab, arg);
};

/** Channel window state for the selected conversation, in minutes remaining. */
export function windowMinutesLeft(state: AppState, conversationId: string): number | null {
  const conversation = findConversation(state, conversationId);
  if (conversation === undefined || conversation.windowExpiresAt === null) return null;
  return minutesUntil(conversation.windowExpiresAt, state.dataset.now);
}

const send: ActionHandler = (context) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  const tab: ComposerTab = state.composerTab;
  const body = readDraft(state, id, tab).trim();
  if (body === '') {
    pushToast(state, state.lang === 'ar' ? 'اكتب رسالة أولًا' : 'Write something first', 'warning');
    context.refresh();
    return;
  }
  if (tab === 'reply') {
    const left = windowMinutesLeft(state, id);
    if (left !== null && left <= 0) {
      // Typed failure: no state change, and the draft is deliberately kept.
      pushToast(
        state,
        state.lang === 'ar'
          ? 'نافذة الرد على هذه القناة انتهت — استخدم قالبًا معتمدًا. لم تُحذف المسودة.'
          : 'The channel window has expired — use an approved template. Your draft is kept.',
        'danger',
      );
      context.refresh();
      return;
    }
    const actor = currentActor(state);
    appendTimeline(state, id, {
      kind: 'message',
      id: nextId(state, 'msg'),
      direction: 'out',
      authorName: state.lang === 'ar' ? actor.name : actor.nameEn,
      body,
      at: state.dataset.now.toISOString(),
      delivery: 'sent',
    });
    patchConversation(state, id, {
      snippet: body,
      snippetDirection: 'out',
      lastActivityAt: state.dataset.now.toISOString(),
      unreadCount: 0,
    });
  } else {
    const actor = currentActor(state);
    appendTimeline(state, id, {
      kind: 'note',
      id: nextId(state, 'note'),
      authorName: state.lang === 'ar' ? actor.name : actor.nameEn,
      body,
      at: state.dataset.now.toISOString(),
    });
    // A note never touches the customer-visible snippet or the provider window.
  }
  writeDraft(state, id, tab, '');
  pushToast(
    state,
    tab === 'reply'
      ? state.lang === 'ar'
        ? 'تم إرسال الرد'
        : 'Reply sent'
      : state.lang === 'ar'
        ? 'تمت إضافة الملاحظة الداخلية'
        : 'Private note added',
  );
  context.refresh();
};

const insertText: ActionHandler = (context, arg) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  const current = readDraft(state, id, state.composerTab);
  writeDraft(state, id, state.composerTab, current === '' ? arg : `${current} ${arg}`);
  state.openMenu = null;
  context.refresh();
};

const attach: ActionHandler = (context) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  appendTimeline(state, id, {
    kind: 'event',
    id: nextId(state, 'evt'),
    text:
      state.lang === 'ar'
        ? 'أُرفق ملف بالمسودة: enrollment-48127.pdf (عرض توضيحي — لا يُرفع فعليًا)'
        : 'Attached to draft: enrollment-48127.pdf (demo — nothing is uploaded)',
    at: state.dataset.now.toISOString(),
  });
  pushToast(
    state,
    state.lang === 'ar' ? 'أُضيف المرفق إلى المسودة' : 'Attachment added to the draft',
  );
  context.refresh();
};

const assign: ActionHandler = (context, arg) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  const actor = currentActor(state);
  const target = arg === '' ? null : arg;
  if (target !== actor.memberId && !canAssignOthers(actor)) {
    pushToast(
      state,
      state.lang === 'ar'
        ? 'صلاحية conversation.assign غير ممنوحة لدورك'
        : 'Your role lacks conversation.assign',
      'danger',
    );
    state.openMenu = null;
    context.refresh();
    return;
  }
  const member = state.dataset.members.find((entry) => entry.id === target);
  const name =
    member === undefined
      ? state.lang === 'ar'
        ? 'غير مُسندة'
        : 'Unassigned'
      : state.lang === 'ar'
        ? member.name
        : member.nameEn;
  patchConversation(state, id, {
    assigneeId: target,
    participantIds: target === null ? [] : [target],
  });
  appendTimeline(state, id, {
    kind: 'event',
    id: nextId(state, 'evt'),
    text: state.lang === 'ar' ? `تم الإسناد إلى ${name}` : `Assigned to ${name}`,
    at: state.dataset.now.toISOString(),
  });
  state.openMenu = null;
  pushToast(state, state.lang === 'ar' ? `أُسندت إلى ${name}` : `Assigned to ${name}`);
  context.refresh();
};

const claim: ActionHandler = (context, arg) => {
  const state = context.state;
  const conversation = findConversation(state, arg);
  if (conversation === undefined) return;
  const actor = currentActor(state);
  if (conversation.assigneeId !== null) {
    // Atomic, version-checked claim: exactly one winner (business-rules §4.1).
    pushToast(
      state,
      state.lang === 'ar'
        ? 'CONVERSATION_VERSION_CONFLICT — استلمها زميل قبلك'
        : 'CONVERSATION_VERSION_CONFLICT — a colleague claimed it first',
      'danger',
    );
    context.refresh();
    return;
  }
  patchConversation(state, arg, {
    assigneeId: actor.memberId,
    participantIds: [actor.memberId],
    unreadCount: 0,
  });
  appendTimeline(state, arg, {
    kind: 'event',
    id: nextId(state, 'evt'),
    text:
      state.lang === 'ar'
        ? `تم الاستلام بواسطة ${actor.name}`
        : `Claimed by ${actor.nameEn}`,
    at: state.dataset.now.toISOString(),
  });
  pushToast(
    state,
    state.lang === 'ar' ? 'تم استلام المحادثة — المحتوى متاح الآن' : 'Claimed — content unlocked',
  );
  context.navigate('inbox', arg);
};

const setStatus: ActionHandler = (context, arg) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  const status = arg as ConversationStatus;
  if (status === 'resolved') {
    // Resolve requires a disposition — so it opens a dialog, never a bare click.
    state.dialog = { kind: 'resolve', arg: id };
    state.openMenu = null;
    context.refresh();
    return;
  }
  patchConversation(state, id, { status, snoozedUntil: null });
  appendTimeline(state, id, {
    kind: 'event',
    id: nextId(state, 'evt'),
    text:
      state.lang === 'ar'
        ? `تغيّرت الحالة إلى ${status === 'open' ? 'مفتوحة' : 'بانتظار العميل'}`
        : `Status changed to ${status}`,
    at: state.dataset.now.toISOString(),
  });
  state.openMenu = null;
  context.refresh();
};

const resolveWith: ActionHandler = (context, arg) => {
  const state = context.state;
  const dialog = state.dialog;
  if (dialog === null) return;
  const id = dialog.arg;
  patchConversation(state, id, { status: 'resolved', snoozedUntil: null, sla: 'none' });
  appendTimeline(state, id, {
    kind: 'event',
    id: nextId(state, 'evt'),
    text: state.lang === 'ar' ? `تم الحل — التصنيف: ${arg}` : `Resolved — disposition: ${arg}`,
    at: state.dataset.now.toISOString(),
  });
  state.dialog = null;
  pushToast(state, state.lang === 'ar' ? 'تم حل المحادثة' : 'Conversation resolved');
  context.refresh();
};

const snooze: ActionHandler = (context, arg) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  const minutes = Number.parseInt(arg, 10);
  const wake = new Date(state.dataset.now.getTime() + minutes * 60_000);
  patchConversation(state, id, { status: 'snoozed', snoozedUntil: wake.toISOString() });
  appendTimeline(state, id, {
    kind: 'event',
    id: nextId(state, 'evt'),
    text:
      state.lang === 'ar'
        ? `تم التأجيل — وقت الاستيقاظ مخزَّن بتوقيت UTC مع منطقة Africa/Cairo`
        : `Snoozed — wake time stored in UTC with the Africa/Cairo zone`,
    at: state.dataset.now.toISOString(),
  });
  state.dialog = null;
  state.openMenu = null;
  pushToast(state, state.lang === 'ar' ? 'تم تأجيل المحادثة' : 'Conversation snoozed');
  context.refresh();
};

const setPriority: ActionHandler = (context, arg) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  patchConversation(state, id, { priority: arg as Priority });
  state.openMenu = null;
  pushToast(state, state.lang === 'ar' ? 'تم تحديث الأولوية' : 'Priority updated');
  context.refresh();
};

const markUnread: ActionHandler = (context) => {
  const state = context.state;
  const id = selectedId(state);
  if (id === null) return;
  patchConversation(state, id, { unreadCount: 1 });
  state.openMenu = null;
  pushToast(
    state,
    state.lang === 'ar' ? 'أُعيد تعليمها كغير مقروءة' : 'Marked unread for you only',
  );
  context.refresh();
};

const openDialog: ActionHandler = (context, arg) => {
  const separator = arg.indexOf(':');
  const kind = separator === -1 ? arg : arg.slice(0, separator);
  const value = separator === -1 ? '' : arg.slice(separator + 1);
  context.state.dialog = { kind, arg: value };
  context.state.openMenu = null;
  context.state.dialogForm = {};
  context.refresh();
};

const closeDialog: ActionHandler = (context) => {
  context.state.dialog = null;
  context.state.dialogForm = {};
  context.refresh();
};

const formInput: ActionHandler = (context, arg) => {
  const separator = arg.indexOf(':');
  if (separator === -1) return;
  context.state.dialogForm = {
    ...context.state.dialogForm,
    [arg.slice(0, separator)]: arg.slice(separator + 1),
  };
};

/** Same as `form`, but re-renders — used by switches and other visible toggles. */
const formToggle: ActionHandler = (context, arg) => {
  formInput(context, arg);
  context.refresh();
};

const saveView: ActionHandler = (context) => {
  const state = context.state;
  const name = (state.dialogForm.name ?? '').trim();
  if (name === '') {
    pushToast(state, state.lang === 'ar' ? 'اكتب اسمًا للعرض' : 'Name the view first', 'warning');
    context.refresh();
    return;
  }
  const scopeValue = state.dialogForm.scope ?? 'private';
  const scope: SavedView['scope'] =
    scopeValue === 'team' || scopeValue === 'workspace' ? scopeValue : 'private';
  const view: SavedView = {
    id: nextId(state, 'view'),
    name,
    nameEn: name,
    scope,
    criteria: criteriaFromFilter(state.filter),
  };
  state.views = [...state.views, view];
  state.activeViewId = view.id;
  state.dialog = null;
  state.dialogForm = {};
  pushToast(state, state.lang === 'ar' ? 'تم حفظ العرض' : 'View saved');
  context.refresh();
};

const deleteView: ActionHandler = (context, arg) => {
  const state = context.state;
  state.views = state.views.filter((view) => view.id !== arg);
  if (state.activeViewId === arg) state.activeViewId = null;
  state.openMenu = null;
  pushToast(state, state.lang === 'ar' ? 'تم حذف العرض' : 'View deleted');
  context.refresh();
};

const dismissToast: ActionHandler = (context, arg) => {
  context.state.toasts = context.state.toasts.filter((toast) => toast.id !== arg);
  context.refresh();
};

/** Channel actions are demo-local: they never claim a provider result. */
const channelAction: ActionHandler = (context, arg) => {
  const state = context.state;
  const separator = arg.indexOf(':');
  const verb = separator === -1 ? arg : arg.slice(0, separator);
  const messages: Record<string, { ar: string; en: string }> = {
    test: {
      ar: 'اختبار الاتصال غير متاح — لا يوجد مزوّد متصل في هذه النسخة التجريبية',
      en: 'Connection test unavailable — no provider is connected in this demo',
    },
    reconnect: {
      ar: 'إعادة التفويض تبدأ من حساب المزوّد — غير مفعّلة في العرض التجريبي',
      en: 'Re-authorization starts at the provider — disabled in the demo',
    },
    connect: {
      ar: 'الربط يتطلب تفويض OAuth حقيقيًا — غير مفعّل في العرض التجريبي',
      en: 'Connecting needs a real OAuth grant — disabled in the demo',
    },
    disconnect: {
      ar: 'الفصل يتطلب صلاحية channel.manage وتأكيدًا ثانيًا',
      en: 'Disconnecting needs channel.manage and a second confirmation',
    },
  };
  const message = messages[verb];
  if (message === undefined) return;
  pushToast(state, state.lang === 'ar' ? message.ar : message.en, 'warning');
  context.refresh();
};

const campaignAction: ActionHandler = (context, arg) => {
  const state = context.state;
  const separator = arg.indexOf(':');
  const verb = separator === -1 ? arg : arg.slice(0, separator);
  const id = separator === -1 ? '' : arg.slice(separator + 1);
  const campaign = state.dataset.campaigns.find((entry) => entry.id === id);
  if (campaign === undefined) return;
  if (verb === 'launch' && !campaign.approved) {
    pushToast(
      state,
      state.lang === 'ar'
        ? 'الإطلاق مرفوض — «جاهزة» لا تعني «معتمدة». الاعتماد سجل منفصل مرتبط بالمراجعة.'
        : 'Launch rejected — “ready” is not “approved”. Approval is a separate revision-bound record.',
      'danger',
    );
  } else if (verb === 'edit' && campaign.state !== 'draft' && campaign.state !== 'ready') {
    pushToast(
      state,
      state.lang === 'ar'
        ? 'التعديل مرفوض بعد الإطلاق — انسخ الحملة إلى معرّف جديد'
        : 'Edits are rejected after launch — clone to a new campaign ID',
      'danger',
    );
  } else {
    pushToast(
      state,
      state.lang === 'ar'
        ? 'إجراء تجريبي — لا يُرسل شيء إلى أي مزوّد'
        : 'Demo action — nothing is sent to any provider',
      'warning',
    );
  }
  context.refresh();
};

const noop: ActionHandler = (context, arg) => {
  const state = context.state;
  pushToast(
    state,
    arg === ''
      ? state.lang === 'ar'
        ? 'إجراء تجريبي'
        : 'Demo action'
      : arg,
    'warning',
  );
  context.refresh();
};

export const ACTIONS: Readonly<Record<string, ActionHandler>> = {
  nav,
  'close-tab': closeTab,
  theme: toggleTheme,
  open: openConversation,
  queue: setQueue,
  sort: setSort,
  search: setSearch,
  date: setDate,
  'toggle-filter': toggleFilter,
  'clear-filters': clearAll,
  'reset-inbox': resetInbox,
  view: applyView,
  menu: toggleMenu,
  'close-menu': closeMenu,
  group: toggleGroup,
  panel: togglePanel,
  list: toggleList,
  sidebar: toggleSidebar,
  'close-overlays': closeOverlays,
  focus: toggleFocus,
  'resize-list': resizeList,
  'resize-list-step': resizeListStep,
  lang: setLang,
  preview: setPreview,
  role: setRole,
  'composer-tab': setComposerTab,
  'composer-input': composerInput,
  send,
  insert: insertText,
  attach,
  assign,
  claim,
  status: setStatus,
  resolve: resolveWith,
  snooze,
  priority: setPriority,
  'mark-unread': markUnread,
  dialog: openDialog,
  'close-dialog': closeDialog,
  form: formInput,
  'form-toggle': formToggle,
  'save-view': saveView,
  'delete-view': deleteView,
  toast: dismissToast,
  channel: channelAction,
  campaign: campaignAction,
  demo: noop,
};

export function runAction(name: string, context: ActionContext, arg: string): boolean {
  const handler = ACTIONS[name];
  if (handler === undefined) return false;
  handler(context, arg);
  return true;
}

export const CHANNEL_ORDER: readonly ChannelKind[] = ['whatsapp', 'instagram', 'messenger'];
