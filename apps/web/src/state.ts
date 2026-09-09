import type { Dataset, RoleId } from './data';
import { CURRENT_MEMBER_ID, buildDataset } from './data';
import type { Lang } from './format';
import type { Actor } from './permissions';
import {
  disconnectedApi,
  disconnectedChannelsApi,
  disconnectedConversationsApi,
} from './api/people';
import type { LiveState } from './live/store';
import { createLiveState } from './live/store';
import type { Route, ScreenId } from './router';
import { DEFAULT_ROUTE } from './router';

/** The four demonstrable non-happy states, plus `ready`. */
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
  role: RoleId;
  dataset: Dataset;
  openMenu: string | null;
  dialog: DialogState | null;
  dialogForm: Record<string, string>;
  /**
   * Both side zones start closed (task §3): the operator opens Views from the
   * one "Views / القوائم" control and customer details from the thread header.
   * `focusMode` closes both and keeps them closed until it is turned off.
   */
  listOpen: boolean;
  /** Queue-list width in px, clamped to LIST_WIDTH_MIN..LIST_WIDTH_MAX. */
  listWidth: number;
  /** Which half of the live inbox is showing: the queue, or this agent's work. */
  inboxQueue: 'unassigned' | 'mine';
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
   * Server-backed state for the People screen. Kept separate from the demo
   * dataset above so there is never a doubt about which parts of the workspace
   * are talking to the API and which are still seeded locally.
   */
  live: LiveState;
}

/**
 * Builds the workspace state.
 *
 * `live` defaults to a state whose API has no transport, because that is the
 * truthful default for a page with no server behind it: the demo screens still
 * work, and anything that asks the API reports a network failure rather than
 * inventing a success. `mount` always passes the real one.
 */
export function createState(
  now: Date,
  live: LiveState = createLiveState(
    disconnectedApi(),
    disconnectedChannelsApi(),
    disconnectedConversationsApi(),
  ),
): AppState {
  const dataset = buildDataset(now);
  return {
    lang: 'ar',
    theme: 'light',
    openTabs: ['inbox'],
    route: DEFAULT_ROUTE,
    role: 'supervisor',
    dataset,
    openMenu: null,
    dialog: null,
    dialogForm: {},
    listOpen: false,
    listWidth: LIST_WIDTH_DEFAULT,
    inboxQueue: 'unassigned',
    clock: now,
    toasts: [],
    sequence: 0,
    live,
  };
}

/**
 * The signed-in operator, re-roled by the "view as" control. The identity stays
 * the same person — only the effective role changes — so "Mine" keeps meaning
 * across a role switch and the projection rules are visible on real data.
 */
export function currentActor(state: AppState): Actor {
  // The seeded dataset always contains this member — `buildDataset` writes it —
  // so there is no "member not found" case to invent a placeholder for. If the
  // seed ever stopped including them, the type error would say so here rather
  // than a fallback quietly rendering a workspace belonging to nobody.
  const member = requireMember(state.dataset.members);
  return {
    memberId: CURRENT_MEMBER_ID,
    name: member.name,
    nameEn: member.nameEn,
    role: state.role,
    inboxIds: member.inboxIds,
    teamIds: member.teamIds,
  };
}

function requireMember(members: Dataset['members']): Dataset['members'][number] {
  const member = members.find((entry) => entry.id === CURRENT_MEMBER_ID);
  if (member === undefined) {
    throw new Error(`the seeded dataset has no member ${CURRENT_MEMBER_ID}`);
  }
  return member;
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
  if (state.role !== 'supervisor') params.as = state.role;
  if (state.route.screen === 'inbox' && state.inboxQueue !== 'unassigned') {
    params.queue = state.inboxQueue;
  }
  return params;
}

export function applyRoute(state: AppState, route: Route): void {
  const params = route.params;
  state.route = route;
  state.lang = params.lang === 'en' ? 'en' : 'ar';
  state.role = pick(VIEWABLE_ROLES, params.as, 'supervisor');
  if (route.screen === 'inbox') {
    // Which half of the inbox is showing is worth sharing in a link; nothing
    // else about it is local state any more.
    state.inboxQueue = params.queue === 'mine' ? 'mine' : 'unassigned';
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
