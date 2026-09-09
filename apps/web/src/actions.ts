import type { ChannelKind } from './data';
import { SCREENS } from './router';
import type { ScreenId } from './router';
import type { AppState } from './state';
import { clampListWidth, pushToast, VIEWABLE_ROLES } from './state';

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

const toggleMenu: ActionHandler = (context, arg) => {
  context.state.openMenu = context.state.openMenu === arg ? null : arg;
  context.refresh();
};

const closeMenu: ActionHandler = (context) => {
  context.state.openMenu = null;
  context.refresh();
};

const toggleList: ActionHandler = (context) => {
  context.state.listOpen = !context.state.listOpen;
  context.refresh();
};

/** Closes whichever overlay zones are open. Bound to Escape and to the scrim. */
const closeOverlays: ActionHandler = (context, arg) => {
  if (arg === 'list' || arg === '') context.state.listOpen = false;
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

const setRole: ActionHandler = (context, arg) => {
  if (!isMember(VIEWABLE_ROLES, arg)) return;
  context.state.role = arg;
  context.state.openMenu = null;
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

const dismissToast: ActionHandler = (context, arg) => {
  context.state.toasts = context.state.toasts.filter((toast) => toast.id !== arg);
  context.refresh();
};

/** Channel actions are demo-local: they never claim a provider result. */
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

/**
 * The remaining demo actions.
 *
 * Everything the Inbox used to dispatch has gone with it: the inbox is served
 * by `live-*` actions that reach the API. What is left here belongs to the
 * workspace shell (tabs, theme, language, the rail) and to the three screens
 * that are still seeded demos — Broadcasts, Analytics and Settings. When those
 * are wired, this table goes with them.
 */
export const ACTIONS: Readonly<Record<string, ActionHandler>> = {
  nav,
  'close-tab': closeTab,
  theme: toggleTheme,
  menu: toggleMenu,
  'close-menu': closeMenu,
  list: toggleList,
  'close-overlays': closeOverlays,
  'resize-list': resizeList,
  'resize-list-step': resizeListStep,
  lang: setLang,
  role: setRole,
  dialog: openDialog,
  'close-dialog': closeDialog,
  form: formInput,
  'form-toggle': formToggle,
  toast: dismissToast,
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
