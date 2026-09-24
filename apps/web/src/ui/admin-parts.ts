import type { Person, ScopeRef, Team } from '../api/people.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { formatHash } from '../router.js';
import type { ScreenId } from '../router.js';
import type { IconName } from '../icons.js';
import { icon } from '../icons.js';
import { initials } from '../format.js';
import { openSession, rowsOf } from '../live/store.js';
import type { LiveState, Resource } from '../live/store.js';
import type { AppState } from '../state.js';
import { routeParamsWithLanguage } from '../state.js';
import { t } from './copy.js';
import type { Phrase } from './copy.js';
import { avatar, badge, emptyState, errorState, isolated, skeleton } from './parts.js';
import type { EmptyStateOptions, Tone } from './parts.js';

/**
 * The building blocks the three user-management screens share: the page head
 * with its breadcrumb, tabs, a row's action menu, and the member identity
 * cell. Presentation only — each control dispatches an existing action, and the
 * server decides every one of them.
 */

export const MEMBER_STATUS: Readonly<Record<string, { readonly label: Phrase; readonly tone: Tone }>> = {
  active: { label: { ar: 'نشط', en: 'Active' }, tone: 'success' },
  suspended: { label: { ar: 'موقوف', en: 'Suspended' }, tone: 'warning' },
  revoked: { label: { ar: 'ملغى', en: 'Revoked' }, tone: 'neutral' },
  pending: { label: { ar: 'بانتظار القبول', en: 'Pending' }, tone: 'accent' },
  accepted: { label: { ar: 'مقبولة', en: 'Accepted' }, tone: 'success' },
  declined: { label: { ar: 'مرفوضة', en: 'Declined' }, tone: 'neutral' },
  cancelled: { label: { ar: 'ملغاة', en: 'Cancelled' }, tone: 'neutral' },
};

export function statusBadge(state: AppState, value: string): HTMLElement {
  const view = MEMBER_STATUS[value];
  return view === undefined ? badge(value, 'neutral') : badge(t(state, view.label.ar, view.label.en), view.tone, { dot: true });
}

const SCOPE_TYPES: Readonly<Record<string, Phrase>> = {
  tenant: { ar: 'مساحة العمل كلها', en: 'Whole workspace' },
  team: { ar: 'فريق', en: 'Team' },
  inbox: { ar: 'صندوق وارد', en: 'Inbox' },
};

/** A membership's reach, in words. No scope at all is flagged, never hidden. */
export function scopeSummary(state: AppState, scopes: readonly ScopeRef[]): HTMLElement {
  if (scopes.length === 0) return badge(t(state, 'بلا نطاق', 'No scope'), 'warning');
  const types = [...new Set(scopes.map((scope) => scope.type))];
  return h('span', { class: 'badge-row' }, types.map((type) => {
    const view = SCOPE_TYPES[type];
    const count = scopes.filter((scope) => scope.type === type).length;
    const label = view === undefined ? type : t(state, view.ar, view.en);
    return badge(type === 'tenant' || count === 1 ? label : `${label} × ${String(count)}`, 'neutral');
  }));
}

/** The teams a membership belongs to, read from the teams the server listed. */
export function teamsOf(live: LiveState, membershipId: string): readonly Team[] {
  return rowsOf(live.teams).filter((team) => team.members.some((member) => member.membership_id === membershipId));
}

export function teamList(state: AppState, teams: readonly Team[]): Child {
  if (teams.length === 0) return h('span', { class: 'muted' }, [t(state, 'بلا فريق', 'No team')]);
  return h('span', { class: 'chip-list' }, teams.map((team) => h('span', { class: 'chip' }, [team.name])));
}

/** Avatar, email and a "you" marker. People have no display name in this API. */
export function memberCell(state: AppState, person: Person): HTMLElement {
  const self = person.email === openSession(state.live).email;
  return h('div', { class: 'member' }, [
    avatar({ initials: initials(person.email.split('@')[0] as string), size: 'sm' }),
    h('div', { class: 'member__text' }, [
      h('span', { class: 'table__primary' }, [isolated(person.email)]),
      self ? h('span', { class: 'table__sub' }, [t(state, 'أنت', 'You')]) : null,
    ]),
  ]);
}

/** A link inside the app, carrying the language like every navigation does. */
export function screenLink(state: AppState, screen: ScreenId, params: Readonly<Record<string, string>> | undefined, children: readonly Child[], extraClass = ''): HTMLElement {
  return h('a', {
    class: `link${extraClass === '' ? '' : ` ${extraClass}`}`,
    href: formatHash({ screen, conversationId: null, params: routeParamsWithLanguage(state, params ?? {}) }),
  }, children);
}

/**
 * "User management / Roles / Admin", then the page's own heading, summary and
 * actions. The heading is an h2: the header's h1 already names the screen.
 */
export function adminHead(
  state: AppState,
  options: {
    readonly trail: readonly { readonly label: string; readonly screen?: ScreenId; readonly params?: Readonly<Record<string, string>> }[];
    readonly title: string;
    readonly titleIcon?: IconName;
    readonly subtitle?: string | undefined;
    readonly badges?: readonly Child[];
    readonly actions?: readonly Child[];
  },
): HTMLElement {
  return h('header', { class: 'admin-head' }, [
    h('nav', { class: 'breadcrumb', 'aria-label': t(state, 'مسار التنقل', 'Breadcrumb') }, [
      h('ol', {}, options.trail.map((step, index) => h('li', {}, [
        step.screen === undefined
          ? h('span', { 'aria-current': index === options.trail.length - 1 ? 'page' : undefined }, [isolated(step.label)])
          : screenLink(state, step.screen, step.params, [isolated(step.label)]),
      ]))),
    ]),
    h('div', { class: 'admin-head__row' }, [
      options.titleIcon === undefined ? null : h('span', { class: 'admin-head__icon', 'aria-hidden': 'true' }, [icon(options.titleIcon, 20)]),
      h('div', { class: 'admin-head__titles' }, [
        h('div', { class: 'admin-head__titleline' }, [
          // Role and team names are typed by people, in either script: isolated,
          // so a Latin name's punctuation stays with it on an Arabic page.
          h('h2', { class: 'admin-head__title' }, [isolated(options.title)]),
          ...(options.badges ?? []),
        ]),
        options.subtitle === undefined ? null : h('p', { class: 'admin-head__subtitle' }, [isolated(options.subtitle)]),
      ]),
      options.actions === undefined || options.actions.length === 0 ? null : h('div', { class: 'admin-head__actions' }, options.actions),
    ]),
  ]);
}

/**
 * Tabs that are links: each tab is a route, so Back returns to it and a link
 * shares it. `role="tablist"` with `aria-selected`, per the ARIA pattern.
 */
export function routeTabs(
  state: AppState,
  label: string,
  screen: ScreenId,
  tabs: readonly { readonly id: string; readonly label: string; readonly count?: number | undefined; readonly params: Readonly<Record<string, string>> }[],
  current: string,
): HTMLElement {
  return h('div', { class: 'admin-tabs', role: 'tablist', 'aria-label': label }, tabs.map((tab) => h('a', {
    class: 'admin-tabs__tab',
    role: 'tab',
    id: `tab-${tab.id}`,
    'aria-selected': String(tab.id === current),
    'aria-controls': tab.id === current ? `tabpanel-${tab.id}` : undefined,
    href: formatHash({ screen, conversationId: null, params: routeParamsWithLanguage(state, tab.params) }),
  }, [
    tab.label,
    tab.count === undefined ? null : h('span', { class: 'admin-tabs__count' }, [String(tab.count)]),
  ])));
}

export interface MenuItem {
  readonly label: string;
  readonly icon: IconName;
  readonly act: string;
  readonly arg?: string | undefined;
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * A row's "More actions" button and, while open, its menu. Items that would
 * certainly be refused are not offered; everything offered is still decided by
 * the server.
 */
export function rowMenu(state: AppState, id: string, label: string, items: readonly (MenuItem | null)[]): HTMLElement | null {
  const offered = items.filter((item): item is MenuItem => item !== null);
  if (offered.length === 0) return null;
  const open = state.openMenu === id;
  return h('div', { class: 'menu-anchor' }, [
    h('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm btn--icon row-menu__trigger',
      'data-act': 'menu',
      'data-arg': id,
      'aria-haspopup': 'menu',
      'aria-expanded': String(open),
      'aria-label': label,
      title: label,
    }, [icon('dots', 16)]),
    open
      ? h('div', { class: 'menu row-menu', role: 'menu', 'data-overlay': 'menu', 'aria-label': label }, offered.map((item) => h('button', {
          type: 'button',
          class: `menu__item${item.danger === true ? ' menu__item--danger' : ''}`,
          role: 'menuitem',
          'data-act': item.act,
          'data-arg': item.arg,
          disabled: item.disabled,
        }, [icon(item.icon, 16), h('span', { class: 'menu__label' }, [item.label])])))
      : null,
  ]);
}

/** One place that turns a list resource into waiting, refused, empty or rows. */
export function resourceView<T>(
  state: AppState,
  resource: Resource<readonly T[]>,
  empty: EmptyStateOptions,
  render: (rows: readonly T[]) => Child,
): Child {
  if (resource.status === 'idle' || resource.status === 'loading') return skeleton(state, 4);
  if (resource.status === 'error') return errorState(state, resource.error, 'live-reload');
  if (resource.value.length === 0) return emptyState(empty);
  return render(resource.value);
}

/** A search box that filters what is already on screen. */
export function searchBox(value: string, act: string, placeholder: string, label: string): HTMLElement {
  return h('label', { class: 'admin-search' }, [
    icon('search', 16),
    h('input', { class: 'admin-search__input', type: 'search', value, placeholder, 'aria-label': label, 'data-act': act }),
  ]);
}

/** Case- and script-insensitive enough for names, emails and keys. */
export function matches(query: string, ...values: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || values.some((value) => value.toLowerCase().includes(needle));
}
