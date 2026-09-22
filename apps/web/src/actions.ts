import { SCREENS } from './router';
import type { ScreenId } from './router';
import type { AppState } from './state';
import { clampListWidth, NO_ANALYTICS_FILTERS } from './state';

/**
 * Every interactive control in the UI carries `data-act` (+ optional `data-arg`)
 * and is dispatched through this table by one delegated listener in app.ts.
 * Handlers mutate state and never touch the DOM, which is what makes them
 * directly testable without a render.
 *
 * Nothing here reaches the server. These are the operator's view choices —
 * navigation, theme, language, which drawer is open — and the server-backed
 * actions live in `live/dispatch.ts`.
 */

export interface ActionContext {
  readonly state: AppState;
  /**
   * Applies a route change and re-renders. `conversationId` is required, not
   * optional: every call site passes it, and an optional parameter invented an
   * `undefined` case no caller could produce.
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

const nav: ActionHandler = (context, arg) => {
  if (!isMember(SCREENS, arg)) return;
  const state = context.state;
  state.openMenu = null;
  state.listOpen = false;
  // Choosing a destination is what a navigation drawer is for; leaving it open
  // over the screen that was just chosen would hide that screen.
  state.navOpen = false;
  context.navigate(arg, arg === 'inbox' ? selectedId(state) : null);
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

const toggleNavCollapsed: ActionHandler = (context) => {
  context.state.navCollapsed = !context.state.navCollapsed;
  context.refresh();
};

const openNavDrawer: ActionHandler = (context) => {
  context.state.navOpen = true;
  context.state.openMenu = null;
  context.refresh();
};

const closeNavDrawer: ActionHandler = (context) => {
  context.state.navOpen = false;
  context.refresh();
};

const toggleList: ActionHandler = (context) => {
  context.state.listOpen = !context.state.listOpen;
  context.refresh();
};

/** Closes whichever overlay zones are open. Bound to Escape and to the scrim. */
const closeOverlays: ActionHandler = (context, arg) => {
  if (arg === 'list' || arg === '') context.state.listOpen = false;
  if (arg === 'panel-drawer' || arg === '') context.state.panelDrawer = false;
  // The panel's own close button hides it in either arrangement.
  if (arg === 'panel') {
    context.state.panelOpen = false;
    context.state.panelDrawer = false;
  }
  context.refresh();
};

const togglePanel: ActionHandler = (context) => {
  context.state.panelOpen = !context.state.panelOpen;
  context.refresh();
};

const composerTab: ActionHandler = (context, arg) => {
  if (arg !== 'reply' && arg !== 'note') return;
  context.state.composerTab = arg;
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
  context.state.passwordVisible = false;
  context.state.live.error = null;
  context.refresh();
};

const closeDialog: ActionHandler = (context) => {
  context.state.dialog = null;
  context.state.dialogForm = {};
  context.state.passwordVisible = false;
  context.state.live.error = null;
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

/** Same as `form`, but re-renders — used by controls whose value gates another. */
const formToggle: ActionHandler = (context, arg) => {
  formInput(context, arg);
  context.refresh();
};

const passwordVisibility: ActionHandler = (context) => {
  context.state.passwordVisible = !context.state.passwordVisible;
  context.refresh();
};

const dismissToast: ActionHandler = (context, arg) => {
  context.state.toasts = context.state.toasts.filter((toast) => toast.id !== arg);
  context.refresh();
};

/** Narrows the connected-integrations list to one channel kind, or clears it. */
const channelKind: ActionHandler = (context, arg) => {
  context.state.channelKind = arg;
  context.state.expandedConnection = null;
  context.refresh();
};

const toggleConnection: ActionHandler = (context, arg) => {
  context.state.expandedConnection = context.state.expandedConnection === arg ? null : arg;
  context.refresh();
};

/**
 * Opens one kind's connections for management: `"<kind>:<connectionId>"`, or
 * `"<kind>:"` for the first live one. Focus goes to that connection so a
 * keyboard user lands where the catalogue card sent them.
 */
const manageChannel: ActionHandler = (context, arg) => {
  const state = context.state;
  const separator = arg.indexOf(':');
  const kind = separator === -1 ? arg : arg.slice(0, separator);
  const named = separator === -1 ? '' : arg.slice(separator + 1);
  const connections = state.live.connections.status === 'ready' ? state.live.connections.value : [];
  const target = named !== ''
    ? named
    : connections.find((connection) => connection.kind === kind && connection.disconnected_at === null)?.id ?? null;
  state.channelKind = kind;
  state.expandedConnection = target;
  state.focusTarget = target === null ? null : `[data-connection="${target}"] [data-act="connection-toggle"]`;
  context.refresh();
};

const setTheme: ActionHandler = (context, arg) => {
  if (arg !== 'light' && arg !== 'dark') return;
  context.state.theme = arg;
  context.refresh();
};

const setNav: ActionHandler = (context, arg) => {
  if (arg !== 'collapsed' && arg !== 'expanded') return;
  context.state.navCollapsed = arg === 'collapsed';
  context.refresh();
};

/** From a campaign to its report: Analytics, narrowed to that campaign. */
const campaignReport: ActionHandler = (context, arg) => {
  context.state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, campaignId: arg };
  context.navigate('analytics', null);
};

const analyticsView: ActionHandler = (context, arg) => {
  if (arg !== 'campaigns' && arg !== 'operations') return;
  context.state.analyticsView = arg;
  context.navigate('analytics', null);
};

/** From a report row to the campaign itself, selected. */
const campaignOpen: ActionHandler = (context, arg) => {
  context.state.live.selectedCampaignId = arg;
  context.state.live.campaignRecipients = { status: 'idle' };
  context.navigate('broadcasts', null);
};

const togglePanelDrawer: ActionHandler = (context) => {
  context.state.panelDrawer = !context.state.panelDrawer;
  context.refresh();
};

export const ACTIONS: Readonly<Record<string, ActionHandler>> = {
  nav,
  theme: toggleTheme,
  menu: toggleMenu,
  'close-menu': closeMenu,
  'nav-collapse': toggleNavCollapsed,
  'nav-drawer': openNavDrawer,
  'nav-drawer-close': closeNavDrawer,
  list: toggleList,
  'close-overlays': closeOverlays,
  panel: togglePanel,
  'composer-tab': composerTab,
  'resize-list': resizeList,
  'resize-list-step': resizeListStep,
  lang: setLang,
  dialog: openDialog,
  'close-dialog': closeDialog,
  form: formInput,
  'form-toggle': formToggle,
  toast: dismissToast,
  'password-visibility': passwordVisibility,
  'channel-kind': channelKind,
  'connection-toggle': toggleConnection,
  'channel-manage': manageChannel,
  'panel-drawer': togglePanelDrawer,
  'theme-set': setTheme,
  'nav-set': setNav,
  'campaign-report': campaignReport,
  'analytics-view': analyticsView,
  'campaign-open': campaignOpen,
};

export function runAction(name: string, context: ActionContext, arg: string): boolean {
  const handler = ACTIONS[name];
  if (handler === undefined) return false;
  handler(context, arg);
  return true;
}
