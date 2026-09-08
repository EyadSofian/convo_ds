import type {
  ConversationRecord,
  Dataset,
  RoleId,
  SavedView,
  SortOrder,
  TimelineItem,
} from './data';
import { CURRENT_MEMBER_ID, buildDataset } from './data';
import type { FilterState, QueueSegment } from './filters';
import { createFilter, filterFromView, QUEUE_SEGMENTS, SORT_VALUES } from './filters';
import type { Lang } from './format';
import type { Actor } from './permissions';
import type { Route, ScreenId } from './router';
import { DEFAULT_ROUTE } from './router';

/** The four demonstrable non-happy states, plus `ready`. */
export type PreviewState = 'ready' | 'loading' | 'empty' | 'offline' | 'denied';

export const PREVIEW_STATES: readonly PreviewState[] = [
  'ready',
  'loading',
  'empty',
  'offline',
  'denied',
];

export const VIEWABLE_ROLES: readonly RoleId[] = [
  'supervisor',
  'agent',
  'admin',
  'campaign_manager',
];

/**
 * Queue-list resize bounds. Narrower than 300px and the one-line preview stops
 * being readable; wider than 380px and the timeline loses room it needs more.
 * Mirrored by `--list-width-min` / `--list-width-max` in styles/tokens.css.
 */
export const LIST_WIDTH_MIN = 300;
export const LIST_WIDTH_MAX = 380;
export const LIST_WIDTH_DEFAULT = 332;

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

export interface AppState {
  lang: Lang;
  theme: Theme;
  openTabs: ScreenId[];
  route: Route;
  preview: PreviewState;
  role: RoleId;
  dataset: Dataset;
  conversations: ConversationRecord[];
  timelines: Record<string, TimelineItem[]>;
  views: SavedView[];
  filter: FilterState;
  activeViewId: string | null;
  composerTab: ComposerTab;
  drafts: Record<string, string>;
  openMenu: string | null;
  dialog: DialogState | null;
  dialogForm: Record<string, string>;
  /**
   * Both side zones start closed (task §3): the operator opens Views from the
   * one "Views / القوائم" control and customer details from the thread header.
   * `focusMode` closes both and keeps them closed until it is turned off.
   */
  panelOpen: boolean;
  viewsOpen: boolean;
  listOpen: boolean;
  focusMode: boolean;
  /** Queue-list width in px, clamped to LIST_WIDTH_MIN..LIST_WIDTH_MAX. */
  listWidth: number;
  collapsedGroups: string[];
  toasts: Toast[];
  sequence: number;
}

export function createState(now: Date): AppState {
  const dataset = buildDataset(now);
  return {
    lang: 'ar',
    theme: 'light',
    openTabs: ['inbox'],
    route: DEFAULT_ROUTE,
    preview: 'ready',
    role: 'supervisor',
    dataset,
    conversations: [...dataset.conversations],
    timelines: Object.fromEntries(
      Object.entries(dataset.timelines).map(([id, items]) => [id, [...items]]),
    ),
    views: [...dataset.views],
    filter: createFilter(),
    activeViewId: null,
    composerTab: 'reply',
    drafts: {},
    openMenu: null,
    dialog: null,
    dialogForm: {},
    panelOpen: false,
    viewsOpen: false,
    listOpen: false,
    focusMode: false,
    listWidth: LIST_WIDTH_DEFAULT,
    collapsedGroups: [],
    toasts: [],
    sequence: 0,
  };
}

/**
 * The signed-in operator, re-roled by the "view as" control. The identity stays
 * the same person — only the effective role changes — so "Mine" keeps meaning
 * across a role switch and the projection rules are visible on real data.
 */
export function currentActor(state: AppState): Actor {
  const member = state.dataset.members.find((entry) => entry.id === CURRENT_MEMBER_ID);
  const base = member ?? {
    name: 'CONVO',
    nameEn: 'CONVO',
    inboxIds: [] as readonly string[],
    teamIds: [] as readonly string[],
  };
  return {
    memberId: CURRENT_MEMBER_ID,
    name: base.name,
    nameEn: base.nameEn,
    role: state.role,
    inboxIds: base.inboxIds,
    teamIds: base.teamIds,
  };
}

export function findConversation(state: AppState, id: string): ConversationRecord | undefined {
  return state.conversations.find((entry) => entry.id === id);
}

export function patchConversation(
  state: AppState,
  id: string,
  patch: Partial<ConversationRecord>,
): void {
  state.conversations = state.conversations.map((entry) =>
    entry.id === id ? { ...entry, ...patch } : entry,
  );
}

export function appendTimeline(state: AppState, id: string, item: TimelineItem): void {
  state.timelines = { ...state.timelines, [id]: [...(state.timelines[id] ?? []), item] };
}

export function nextId(state: AppState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}

export function pushToast(state: AppState, text: string, tone: Toast['tone'] = 'default'): void {
  const toast: Toast = { id: nextId(state, 'toast'), text, tone };
  state.toasts = [...state.toasts, toast].slice(-3);
}

export function draftKey(conversationId: string, tab: ComposerTab): string {
  return `${conversationId}|${tab}`;
}

export function readDraft(state: AppState, conversationId: string, tab: ComposerTab): string {
  return state.drafts[draftKey(conversationId, tab)] ?? '';
}

export function writeDraft(
  state: AppState,
  conversationId: string,
  tab: ComposerTab,
  value: string,
): void {
  state.drafts = { ...state.drafts, [draftKey(conversationId, tab)]: value };
}

/* ---------------------------------------------------------------------------
 * URL <-> state. Only the parts an operator would want to share are encoded.
 * ------------------------------------------------------------------------- */

function pick<T extends string>(
  values: readonly T[],
  candidate: string | undefined,
  fallback: T,
): T {
  return values.includes(candidate as T) ? (candidate as T) : fallback;
}

export function routeParamsFor(state: AppState): Record<string, string> {
  const params: Record<string, string> = {};
  if (state.lang !== 'ar') params.lang = state.lang;
  if (state.preview !== 'ready') params.state = state.preview;
  if (state.role !== 'supervisor') params.as = state.role;
  if (state.route.screen === 'inbox') {
    if (state.activeViewId !== null) params.view = state.activeViewId;
    if (state.filter.queue !== 'all') params.queue = state.filter.queue;
    if (state.filter.sort !== 'recent') params.sort = state.filter.sort;
    if (state.filter.query.trim() !== '') params.q = state.filter.query;
  }
  return params;
}

export function applyRoute(state: AppState, route: Route): void {
  const params = route.params;
  state.route = route;
  state.lang = params.lang === 'en' ? 'en' : 'ar';
  state.preview = pick(PREVIEW_STATES, params.state, 'ready');
  state.role = pick(VIEWABLE_ROLES, params.as, 'supervisor');
  if (route.screen === 'inbox') {
    const viewId = params.view ?? '';
    const view = state.views.find((entry) => entry.id === viewId);
    state.activeViewId = view === undefined ? null : view.id;
    // A view in the URL rebuilds its criteria, so a shared link reproduces the
    // same result set. Touching any filter clears `view`, so this never
    // overwrites a manual tweak layered on top of a view.
    if (view !== undefined) state.filter = filterFromView(view, state.filter);
    state.filter = {
      ...state.filter,
      queue: pick<QueueSegment>(QUEUE_SEGMENTS, params.queue, state.filter.queue),
      sort: pick<SortOrder>(SORT_VALUES, params.sort, state.filter.sort),
      query: params.q ?? state.filter.query,
    };
  }
}

export function screenTitle(screen: ScreenId, lang: Lang): string {
  const titles: Record<ScreenId, Record<Lang, string>> = {
    inbox: { ar: 'صندوق الوارد', en: 'Inbox' },
    channels: { ar: 'القنوات', en: 'Channels' },
    people: { ar: 'الأفراد والأدوار', en: 'People & roles' },
    broadcasts: { ar: 'الحملات', en: 'Broadcasts' },
    analytics: { ar: 'التقارير', en: 'Analytics' },
    settings: { ar: 'الإعدادات', en: 'Settings' },
  };
  return titles[screen][lang];
}
