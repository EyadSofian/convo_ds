import type { Lang } from './format';
import {
  disconnectedApi,
  disconnectedChannelsApi,
  disconnectedContactsApi,
  disconnectedConversationsApi,
} from './api/people';
import type { LiveState } from './live/store';
import { createLiveState } from './live/store';
import type { Route, ScreenId } from './router';
import { DEFAULT_ROUTE } from './router';

/**
 * Queue-list resize bounds. Narrower than 300px and the row cues start to wrap;
 * wider than 400px and the conversation loses room it needs more. Mirrored by
 * `--list-width-min` / `--list-width-max` in styles/tokens.css.
 */
export const LIST_WIDTH_MIN = 300;
export const LIST_WIDTH_MAX = 400;
export const LIST_WIDTH_DEFAULT = 336;

/** Clamps a proposed queue-list width into the supported range. */
export function clampListWidth(value: number): number {
  if (!Number.isFinite(value)) return LIST_WIDTH_DEFAULT;
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, Math.round(value)));
}

export type ComposerTab = 'reply' | 'note';
export type Theme = 'light' | 'dark';

export interface Toast {
  readonly id: string;
  readonly text: string;
  readonly tone: 'default' | 'warning' | 'danger';
}

export interface DialogState {
  readonly kind: string;
  readonly arg: string;
}

/** The Analytics scope as the operator chose it. Empty means "not narrowed". */
export interface AnalyticsFilters {
  readonly from: string;
  readonly to: string;
  readonly channel: string;
  readonly campaignId: string;
}

export const NO_ANALYTICS_FILTERS: AnalyticsFilters = { from: '', to: '', channel: '', campaignId: '' };

export interface AppState {
  lang: Lang;
  theme: Theme;
  route: Route;
  openMenu: string | null;
  dialog: DialogState | null;
  dialogForm: Record<string, string>;
  /** Field-level problems found before a request was sent, keyed like `dialogForm`. */
  formErrors: Record<string, string>;
  /** Whether the sign-in password is shown in clear. Reset with the form. */
  passwordVisible: boolean;
  /** Completion state for the two public, single-use credential flows. */
  authFlowComplete: 'invitation' | 'recovery-request' | 'recovery' | null;
  /** Desktop navigation width. A visual preference, persisted locally. */
  navCollapsed: boolean;
  /** The navigation drawer at narrow widths. Never persisted. */
  navOpen: boolean;
  /** The conversation queue drawer at widths where it cannot sit inline. */
  listOpen: boolean;
  /** Queue-list width in px, clamped to LIST_WIDTH_MIN..LIST_WIDTH_MAX. */
  listWidth: number;
  /** Whether the customer panel is shown beside an open conversation, where it fits inline. */
  panelOpen: boolean;
  /** Whether the customer panel is open as a drawer, where it cannot fit inline. */
  panelDrawer: boolean;
  /**
   * A control to move focus to after the next render, as a selector. Cleared
   * once applied. Used when an action sends the operator somewhere else on the
   * page, so a keyboard user arrives there too.
   */
  focusTarget: string | null;
  /** Which half of the live inbox is showing: the queue, or this agent's work. */
  inboxQueue: 'unassigned' | 'mine';
  /** Which surface the composer writes to. A note never reaches a customer. */
  composerTab: ComposerTab;
  /** The channel kind whose connections the Channels screen is narrowed to. */
  channelKind: string;
  /** The connection whose management details are expanded. */
  expandedConnection: string | null;
  analyticsFilters: AnalyticsFilters;
  /**
   * The moment the screen was last drawn.
   *
   * Relative times ("4m ago") are a function of *when the screen was rendered*,
   * not of when the data arrived, so the clock lives in state and is refreshed
   * on each render. Reading `new Date()` inside a view would make rendering
   * impure and every snapshot of it a different picture.
   */
  clock: Date;
  toasts: Toast[];
  sequence: number;
  /** Everything the server said. Roles and permissions come only from here. */
  live: LiveState;
}

/**
 * Builds the workspace state.
 *
 * `live` defaults to a state whose API has no transport, because that is the
 * truthful default for a page with no server behind it: every request reports a
 * network failure rather than inventing a success. `mount` always passes the
 * real one.
 */
export function createState(
  now: Date,
  live: LiveState = createLiveState(
    disconnectedApi(),
    disconnectedChannelsApi(),
    disconnectedConversationsApi(),
    disconnectedContactsApi(),
  ),
): AppState {
  return {
    lang: 'ar',
    theme: 'light',
    route: DEFAULT_ROUTE,
    openMenu: null,
    dialog: null,
    dialogForm: {},
    formErrors: {},
    passwordVisible: false,
    authFlowComplete: null,
    navCollapsed: true,
    navOpen: false,
    listOpen: false,
    listWidth: LIST_WIDTH_DEFAULT,
    panelOpen: true,
    panelDrawer: false,
    focusTarget: null,
    inboxQueue: 'unassigned',
    composerTab: 'reply',
    channelKind: '',
    expandedConnection: null,
    analyticsFilters: NO_ANALYTICS_FILTERS,
    clock: now,
    toasts: [],
    sequence: 0,
    live,
  };
}

export function nextId(state: AppState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}

export function pushToast(state: AppState, text: string, tone: Toast['tone'] = 'default'): void {
  const toast: Toast = { id: nextId(state, 'toast'), text, tone };
  state.toasts = [...state.toasts, toast].slice(-3);
}

/* ---------------------------------------------------------------------------
 * URL <-> state. Only the parts an operator would want to share are encoded.
 * Nothing about identity or authority is ever read from the URL: a role in a
 * link would be a role anybody could type.
 * ------------------------------------------------------------------------- */

export function routeParamsFor(state: AppState): Record<string, string> {
  const params: Record<string, string> = {};
  if (state.lang !== 'ar') params.lang = state.lang;
  if (state.route.screen === 'inbox' && state.inboxQueue !== 'unassigned') {
    params.queue = state.inboxQueue;
  }
  if (state.route.screen === 'analytics') {
    const filters = state.analyticsFilters;
    if (filters.from !== '') params.from = filters.from;
    if (filters.to !== '') params.to = filters.to;
    if (filters.channel !== '') params.channel = filters.channel;
    if (filters.campaignId !== '') params.campaign = filters.campaignId;
  }
  if (state.route.screen === 'automations') {
    const view = state.route.params['view'];
    if (view !== undefined && ['templates', 'mine', 'runs'].includes(view)) params.view = view;
    const edit = state.route.params['edit'];
    if (edit !== undefined && edit !== '') params.edit = edit;
  }
  return params;
}

export function applyRoute(state: AppState, route: Route): void {
  const params = route.params;
  state.route = route;
  // An absent language parameter means "keep the operator's persisted choice",
  // not "reset to Arabic". Deep links must not overwrite a presentation
  // preference just because they omit it.
  if (params.lang === 'en' || params.lang === 'ar') state.lang = params.lang;
  if (route.screen === 'inbox') {
    // Which half of the inbox is showing is worth sharing in a link; nothing
    // else about it is local state any more.
    state.inboxQueue = params.queue === 'mine' ? 'mine' : 'unassigned';
  }
  if (route.screen === 'analytics') {
    state.analyticsFilters = {
      from: params.from ?? '',
      to: params.to ?? '',
      channel: params.channel ?? '',
      campaignId: params.campaign ?? '',
    };
  }
}

export function screenTitle(screen: ScreenId, lang: Lang): string {
  const titles: Record<ScreenId, Record<Lang, string>> = {
    'accept-invitation': { ar: 'قبول الدعوة', en: 'Accept invitation' },
    'reset-password': { ar: 'إعادة تعيين كلمة المرور', en: 'Reset password' },
    inbox: { ar: 'صندوق الوارد', en: 'Inbox' },
    contacts: { ar: 'جهات الاتصال', en: 'Contacts' },
    channels: { ar: 'القنوات', en: 'Channels' },
    people: { ar: 'الفريق والأدوار', en: 'People & roles' },
    broadcasts: { ar: 'الحملات', en: 'Campaigns' },
    automations: { ar: 'الأتمتة', en: 'Automations' },
    analytics: { ar: 'التقارير', en: 'Analytics' },
    settings: { ar: 'الإعدادات', en: 'Settings' },
  };
  return titles[screen][lang];
}
