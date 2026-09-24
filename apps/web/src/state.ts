import type { Lang } from './format';
import {
  disconnectedApi,
  disconnectedChannelsApi,
  disconnectedContactsApi,
  disconnectedConversationsApi,
} from './api/people';
import {
  INBOX_FILTER_CATALOGUE,
  INBOX_QUERY_DEFAULT,
  INBOX_SORTS,
  type InboxFilter,
  type InboxSort,
} from '@convo/domain';
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
  readonly agentId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly connectionId: string;
  readonly labelId: string;
  readonly campaignId: string;
  readonly priority: string;
  readonly status: string;
}

export type AnalyticsView = 'overview' | 'agents' | 'teams' | 'responses' | 'resolutions' | 'assignments' | 'channels' | 'campaigns';

export const NO_ANALYTICS_FILTERS: AnalyticsFilters = { from: '', to: '', agentId: '', teamId: '', channel: '', connectionId: '', labelId: '', campaignId: '', priority: '', status: '' };

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
  analyticsView: AnalyticsView;
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
  /**
   * Whether the browser reports no network. Presentation only: it changes the
   * status pill, never what is loaded or allowed, and it is never persisted.
   */
  offline: boolean;
  /**
   * Unsaved edits to one custom role's grants: key → scope level. Presentation
   * state only; nothing reaches the server until Save, and the server decides.
   */
  roleDraft: { readonly roleId: string; readonly grants: Readonly<Record<string, string>> } | null;
  /** Free-text filters on the user-management screens. Never persisted. */
  userSearch: string;
  permissionSearch: string;
  /** Permission modules the operator folded away on the role screen. */
  collapsedGroups: readonly string[];
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
    analyticsView: 'campaigns',
    clock: now,
    toasts: [],
    sequence: 0,
    offline: false,
    roleDraft: null,
    userSearch: '',
    permissionSearch: '',
    collapsedGroups: [],
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
  if (state.route.screen === 'inbox') {
    const query = state.live.inboxQuery;
    if (query.queue !== 'mine') params.scope = query.queue;
    if (query.sort !== 'activity_desc') params.sort = query.sort;
    if (query.filters.length > 0) params.filters = JSON.stringify(query.filters);
  }
  if (state.route.screen === 'analytics') {
    if (state.analyticsView !== 'campaigns') params.view = state.analyticsView;
    const filters = state.analyticsFilters;
    if (filters.from !== '') params.from = filters.from;
    if (filters.to !== '') params.to = filters.to;
    if (filters.agentId !== '') params.agentFilter = filters.agentId;
    if (filters.teamId !== '') params.team = filters.teamId;
    if (filters.channel !== '') params.channel = filters.channel;
    if (filters.connectionId !== '') params.connection = filters.connectionId;
    if (filters.labelId !== '') params.label = filters.labelId;
    if (filters.campaignId !== '') params.campaign = filters.campaignId;
    if (filters.priority !== '') params.priority = filters.priority;
    if (filters.status !== '') params.status = filters.status;
    // Agent-detail navigation is identity based. It is deliberately not a
    // display name, because names are neither unique nor stable identifiers.
    const agent = state.route.params.agent;
    if (agent !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agent)) params.agent = agent;
  }
  if (state.route.screen === 'accept-invitation' || state.route.screen === 'reset-password') {
    // The one-time token is the whole point of the link an email delivered.
    // Dropping it on the first URL sync left every invitation and recovery
    // link on "this link is invalid". The server alone decides what it grants.
    const token = state.route.params['token'];
    if (token !== undefined && token !== '') params.token = token;
  }
  if (state.route.screen === 'people' && state.route.params['tab'] === 'invitations') params.tab = 'invitations';
  if (state.route.screen === 'roles') {
    const role = state.route.params['role'];
    if (role !== undefined && role !== '') params.role = role;
    if (role !== undefined && role !== '' && state.route.params['tab'] === 'users') params.tab = 'users';
  }
  if (state.route.screen === 'teams') {
    const team = state.route.params['team'];
    if (team !== undefined && team !== '') params.team = team;
  }
  if (state.route.screen === 'automations') {
    const view = state.route.params['view'];
    if (view !== undefined && ['templates', 'mine', 'runs'].includes(view)) params.view = view;
    const edit = state.route.params['edit'];
    if (edit !== undefined && edit !== '') params.edit = edit;
  }
  return params;
}

/**
 * Carries the global presentation language into a manually authored route.
 *
 * The normal navigation path goes through `routeParamsFor`, but anchors in
 * independently-rendered screens must use this helper as well. A copied deep
 * link therefore retains its language even in a fresh browser with no stored
 * preference. It deliberately carries only a presentation preference, never
 * identity, tenant or permission state.
 */
export function routeParamsWithLanguage(
  state: Pick<AppState, 'lang'>,
  params: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...params, lang: state.lang };
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
    state.live.inboxQuery = {
      ...INBOX_QUERY_DEFAULT,
      queue: params.scope === 'all' ? 'all' : 'mine',
      sort: isInboxSort(params.sort) ? params.sort : 'activity_desc',
      filters: routeFilters(params.filters),
    };
  }
  if (route.screen === 'analytics') {
    const requestedView = params.view === 'operations' ? 'overview' : params.view;
    state.analyticsView = requestedView === 'overview' || requestedView === 'agents' || requestedView === 'teams' || requestedView === 'responses' || requestedView === 'resolutions' || requestedView === 'assignments' || requestedView === 'channels' || requestedView === 'campaigns'
      ? requestedView : 'campaigns';
    state.analyticsFilters = {
      from: params.from ?? '',
      to: params.to ?? '',
      agentId: params.agentFilter ?? '',
      teamId: params.team ?? '',
      channel: params.channel ?? '',
      connectionId: params.connection ?? '',
      labelId: params.label ?? '',
      campaignId: params.campaign ?? '',
      priority: params.priority ?? '',
      status: params.status ?? '',
    };
  }
}

function isInboxSort(value: string | undefined): value is InboxSort {
  return typeof value === 'string' && (INBOX_SORTS as readonly string[]).includes(value);
}

function routeFilters(value: string | undefined): readonly InboxFilter[] {
  if (value === undefined || value.length > 6000) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 20) return [];
    return parsed.every(isRouteFilter) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Reject malformed or unsupported deep-link filters before they enter client
 * state. This intentionally stays structural: the API compiler remains the
 * authority for tenancy, database values and custom-field semantics.
 */
function isRouteFilter(value: unknown): value is InboxFilter {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  if (typeof filter['key'] !== 'string' || typeof filter['operator'] !== 'string') return false;
  const definition = INBOX_FILTER_CATALOGUE.find((entry) => entry.key === filter['key']);
  if (definition === undefined || !definition.operators.includes(filter['operator'])) return false;

  const fieldId = filter['fieldId'];
  if (definition.key === 'custom_field') {
    if (typeof fieldId !== 'string' || !isUuid(fieldId)) return false;
  } else if (fieldId !== undefined) {
    return false;
  }

  const filterValue = filter['value'];
  if (filter['operator'] === 'is_set' || filter['operator'] === 'is_not_set') return filterValue === undefined;
  if (filterValue === undefined) return false;
  if (definition.valueType === 'boolean') return typeof filterValue === 'boolean';
  if (typeof filterValue === 'string') return filterValue.length > 0 && filterValue.length <= 500;
  return Array.isArray(filterValue) && filterValue.length > 0 && filterValue.length <= 20 &&
    filterValue.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 500);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function screenTitle(screen: ScreenId, lang: Lang): string {
  const titles: Record<ScreenId, Record<Lang, string>> = {
    'accept-invitation': { ar: 'قبول الدعوة', en: 'Accept invitation' },
    'reset-password': { ar: 'إعادة تعيين كلمة المرور', en: 'Reset password' },
    inbox: { ar: 'صندوق الوارد', en: 'Inbox' },
    contacts: { ar: 'جهات الاتصال', en: 'Contacts' },
    channels: { ar: 'القنوات', en: 'Channels' },
    people: { ar: 'المستخدمون', en: 'Users' },
    roles: { ar: 'الأدوار', en: 'Roles' },
    teams: { ar: 'الفرق', en: 'Teams' },
    broadcasts: { ar: 'الحملات', en: 'Campaigns' },
    automations: { ar: 'الأتمتة', en: 'Automations' },
    analytics: { ar: 'التقارير', en: 'Analytics' },
    settings: { ar: 'الإعدادات', en: 'Settings' },
  };
  return titles[screen][lang];
}
