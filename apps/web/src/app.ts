import type { ActionContext } from './actions';
import { runAction } from './actions';
import { ApiClient, API_BASE_URL, csrfFromCookie, type FetchLike } from './api/client';
import { disconnectedApi, PeopleApi } from './api/people';
import type { LiveContext } from './live/actions';
import { loadPeopleScreen, loadSession } from './live/actions';
import { runLiveAction } from './live/dispatch';
import { createLiveState } from './live/store';
import { attrOf, closestWithAttr, h, replace } from './dom';
import { icon } from './icons';
import type { IconName } from './icons';
import { ROLE_LABELS } from './permissions';
import type { Route, RouterHost, ScreenId } from './router';
import { onRouteChange, readRoute, SCREENS, writeRoute } from './router';
import type { AppState, PreviewState } from './state';
import {
  applyRoute,
  createState,
  currentActor,
  PREVIEW_STATES,
  routeParamsFor,
  screenTitle,
  VIEWABLE_ROLES,
} from './state';
import { defaultConversationId, renderInbox } from './ui/inbox';
import { renderDialog } from './ui/dialogs';
import { button, isolated, selectControl } from './ui/parts';
import { initials } from './format';
import {
  renderAnalytics,
  renderBroadcasts,
  renderChannels,
  renderSettings,
} from './ui/workspace';
import { renderPeople } from './ui/people-screen';

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

const RAIL_ICONS: Record<ScreenId, IconName> = {
  inbox: 'inbox',
  channels: 'channels',
  people: 'people',
  broadcasts: 'broadcasts',
  analytics: 'analytics',
  settings: 'settings',
};

function renderRail(state: AppState): HTMLElement {
  const actor = currentActor(state);
  const unread = state.conversations.filter((entry) => entry.unreadCount > 0).length;
  return h('nav', { class: 'rail', 'aria-label': t(state, 'التنقّل الرئيسي', 'Primary navigation') }, [
    h('span', { class: 'rail__brand', 'aria-hidden': 'true' }, ['CV']),
    ...SCREENS.map((screen) =>
      h(
        'button',
        {
          type: 'button',
          class: 'rail__item',
          'data-act': 'nav',
          'data-arg': screen,
          'aria-current': state.route.screen === screen ? 'page' : undefined,
          'aria-label': screenTitle(screen, state.lang),
          title: screenTitle(screen, state.lang),
        },
        [
          icon(RAIL_ICONS[screen], 18),
          screen === 'inbox' && unread > 0
            ? h('span', { class: 'rail__badge' }, [String(unread)])
            : null,
        ],
      ),
    ),
    h('span', { class: 'rail__spacer' }),
    h(
      'span',
      {
        class: 'rail__avatar',
        title: `${state.lang === 'ar' ? actor.name : actor.nameEn} · ${ROLE_LABELS[actor.role][state.lang]}`,
      },
      [initials(state.lang === 'ar' ? actor.name : actor.nameEn)],
    ),
  ]);
}

function renderTopbar(state: AppState): HTMLElement {
  const previewLabels: Record<PreviewState, { ar: string; en: string }> = {
    ready: { ar: 'طبيعية', en: 'Ready' },
    loading: { ar: 'تحميل', en: 'Loading' },
    empty: { ar: 'فارغة', en: 'Empty' },
    offline: { ar: 'غير متصل/قديمة', en: 'Offline / stale' },
    denied: { ar: 'صلاحية مرفوضة', en: 'Permission denied' },
  };
  return h('header', { class: 'topbar' }, [
    state.route.screen === 'inbox'
      ? button({
          icon: 'sidebar',
          act: 'sidebar',
          variant: 'ghost',
          small: true,
          pressed: state.viewsOpen,
          title: state.viewsOpen
            ? t(state, 'إغلاق القائمة الجانبية', 'Close sidebar')
            : t(state, 'فتح القائمة الجانبية', 'Open sidebar'),
          extraClass: 'sidebar-toggle',
        })
      : null,
    h('h1', { class: 'topbar__title' }, [screenTitle(state.route.screen, state.lang)]),
    h('span', { class: 'topbar__sub' }, [
      'Digital School · ',
      isolated('workspace.digital-school', true),
    ]),
    h('span', { class: 'topbar__spacer' }),
    h('div', { class: 'topbar__tools' }, [
      h('label', { class: 'storyswitch' }, [
        h('span', { class: 'storyswitch__label' }, [t(state, 'حالة العرض', 'Preview state')]),
        selectControl({
          value: state.preview,
          act: 'preview',
          ariaLabel: t(state, 'حالة العرض', 'Preview state'),
          style: 'inline-size:auto',
          options: PREVIEW_STATES.map((value) => ({
            value,
            label: t(state, previewLabels[value].ar, previewLabels[value].en),
          })),
        }),
      ]),
      h('label', { class: 'storyswitch' }, [
        h('span', { class: 'storyswitch__label' }, [t(state, 'اعرض كـ', 'View as')]),
        selectControl({
          value: state.role,
          act: 'role',
          ariaLabel: t(state, 'اعرض كـ', 'View as'),
          style: 'inline-size:auto',
          options: VIEWABLE_ROLES.map((value) => ({
            value,
            label: ROLE_LABELS[value][state.lang],
          })),
        }),
      ]),
      button({
        icon: state.theme === 'light' ? 'moon' : 'sun',
        act: 'theme',
        variant: 'ghost',
        small: true,
        title: state.theme === 'light'
          ? t(state, 'تشغيل الوضع الداكن', 'Use dark theme')
          : t(state, 'تشغيل الوضع الفاتح', 'Use light theme'),
        extraClass: 'theme-toggle',
      }),
      button({
        label: state.lang === 'ar' ? 'EN' : 'ع',
        icon: 'language',
        act: 'lang',
        arg: state.lang === 'ar' ? 'en' : 'ar',
        small: true,
        title: t(state, 'التبديل إلى الإنجليزية', 'Switch to Arabic'),
      }),
    ]),
  ]);
}


function renderScreen(state: AppState): HTMLElement {
  if (state.route.screen === 'channels') return renderChannels(state);
  if (state.route.screen === 'people') return renderPeople(state);
  if (state.route.screen === 'broadcasts') return renderBroadcasts(state);
  if (state.route.screen === 'analytics') return renderAnalytics(state);
  if (state.route.screen === 'settings') return renderSettings(state);
  return renderInbox(state);
}

function renderToasts(state: AppState): HTMLElement | null {
  if (state.toasts.length === 0) return null;
  return h(
    'div',
    { class: 'toasts', role: 'status', 'aria-live': 'polite' },
    state.toasts.map((toast) =>
      h(
        'div',
        {
          class: toast.tone === 'default' ? 'toast' : `toast toast--${toast.tone}`,
          style: 'pointer-events:auto',
        },
        [
          h('span', {}, [toast.text]),
          h(
            'button',
            {
              type: 'button',
              class: 'chip__remove',
              'data-act': 'toast',
              'data-arg': toast.id,
              'aria-label': t(state, 'إغلاق التنبيه', 'Dismiss'),
            },
            [icon('close', 11)],
          ),
        ],
      ),
    ),
  );
}

export function renderApp(state: AppState): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(
    h('div', { class: 'shell' }, [
      renderRail(state),
      h('div', { class: 'shell__main' }, [
        renderTopbar(state),
        h('main', { class: 'shell__screen' }, [renderScreen(state)]),
      ]),
    ]),
  );
  const dialog = renderDialog(state);
  if (dialog !== null) fragment.appendChild(dialog);
  const toasts = renderToasts(state);
  if (toasts !== null) fragment.appendChild(toasts);
  return fragment;
}

/* --------------------------------------------------------------- focus keep -- */

interface FocusSnapshot {
  readonly key: string;
  /**
   * Which control with that key, in document order. The same action and
   * argument legitimately appear twice — a views-column row and a segment tab
   * both drive `queue:mine` — so the key alone would move focus across the
   * screen on re-render.
   */
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
}

function focusKeyOf(element: Element | null): string | null {
  if (!(element instanceof HTMLElement)) return null;
  const act = element.getAttribute('data-act');
  if (act === null) return null;
  const arg = element.getAttribute('data-arg') ?? element.getAttribute('data-form') ?? '';
  return `${act}|${arg}`;
}

function keyedControls(root: Element, key: string): readonly Element[] {
  return Array.from(root.querySelectorAll('[data-act]')).filter(
    (element) => focusKeyOf(element) === key,
  );
}

function captureFocus(root: Element): FocusSnapshot | null {
  // `Element.ownerDocument` is non-nullable, and this is only ever called with
  // the mount element, so there is no "detached root" case to defend against.
  const active = root.ownerDocument.activeElement;
  const key = focusKeyOf(active);
  if (key === null || active === null) return null;
  const ordinal = keyedControls(root, key).indexOf(active);
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return { key, ordinal, start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 };
  }
  return { key, ordinal, start: -1, end: -1 };
}

function restoreFocus(root: Element, snapshot: FocusSnapshot | null): void {
  if (snapshot === null) return;
  const match = keyedControls(root, snapshot.key)[Math.max(snapshot.ordinal, 0)];
  if (!(match instanceof HTMLElement)) return;
  match.focus();
  if (
    snapshot.start >= 0 &&
    (match instanceof HTMLInputElement || match instanceof HTMLTextAreaElement)
  ) {
    match.setSelectionRange(snapshot.start, snapshot.end);
  }
}

/**
 * Sizes the composer to its content, between the resting and maximum heights
 * in `styles/tokens.css`.
 *
 * A textarea cannot size itself to content in CSS that ships everywhere today
 * (`field-sizing` is not universal), and a fixed `rows` count would either
 * waste the timeline's space at rest or clip a long reply. Measuring after each
 * render keeps the resting composer at exactly 44px — which is what holds the
 * whole composer area inside its 118px budget — while letting a growing draft
 * reach 88px and stop.
 */
export const COMPOSER_MIN_HEIGHT = 44;
export const COMPOSER_MAX_HEIGHT = 88;

function growComposer(root: Element): void {
  const input = root.querySelector('.composer__input');
  if (!(input instanceof HTMLTextAreaElement)) return;
  input.style.height = 'auto';
  // `scrollHeight` excludes the border under `box-sizing: border-box`, so a
  // height set straight from it clips the text by the border width. Both
  // operands are always numbers, so the difference is always a number.
  const border = input.offsetHeight - input.clientHeight;
  const content = input.scrollHeight + border;
  const clamped = Math.min(Math.max(content, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
  input.style.height = `${String(clamped)}px`;
}

/* -------------------------------------------------------------------- mount -- */

export interface AppHandle {
  readonly state: AppState;
  render(): void;
  dispatch(name: string, arg?: string): void;
  destroy(): void;
}

export interface MountOptions {
  readonly root: HTMLElement;
  readonly host: RouterHost;
  readonly now?: Date | undefined;
  /**
   * The HTTP boundary. Injected so a test drives the real client against the
   * real API without a browser, and so nothing here reaches for a global.
   */
  readonly fetch?: FetchLike | undefined;
  readonly readCsrfToken?: (() => string | null) | undefined;
  /** Injected for deterministic idempotency keys in tests. */
  readonly newKey?: (() => string) | undefined;
}

/**
 * Entry point: finds (or creates) the mount node and starts the app.
 *
 * There is deliberately no viewport probe here any more. Both optional side
 * zones start closed (task §3), and whether an open zone is an inline column
 * or a drawer is decided in `styles/shell.css` from the arithmetic that keeps
 * the timeline at 640px. Duplicating that threshold in JavaScript is how the
 * two drift apart.
 */
export function boot(document_: Document, host: RouterHost): AppHandle {
  const existing = document_.getElementById('app');
  const root = existing ?? document_.body.appendChild(document_.createElement('div'));
  root.id = 'app';
  return mount({
    root,
    host,
    fetch: (input, init) => globalThis.fetch(input, init),
    readCsrfToken: () => csrfFromCookie(document_.cookie),
  });
}

export function mount(options: MountOptions): AppHandle {
  const transport = options.fetch;
  const api =
    transport === undefined
      ? // No transport was injected, so this page has no API behind it. Every
        // request fails as a network error, which is what such a screen shows.
        disconnectedApi()
      : new PeopleApi(
          new ApiClient({
            baseUrl: API_BASE_URL,
            fetch: transport,
            readCsrfToken: options.readCsrfToken ?? (() => null),
          }),
        );
  const state = createState(options.now ?? new Date(), createLiveState(api));
  const root = options.root;
  const host = options.host;
  let sessionRequested = false;

  const render = (): void => {
    const snapshot = captureFocus(root);
    const document_ = root.ownerDocument;
    document_.documentElement.setAttribute('lang', state.lang);
    document_.documentElement.setAttribute('dir', state.lang === 'ar' ? 'rtl' : 'ltr');
    document_.documentElement.setAttribute('data-theme', state.theme);
    root.className = 'app-root';
    replace(root, [renderApp(state)]);
    growComposer(root);
    restoreFocus(root, snapshot);
  };

  const syncUrl = (): void => {
    const next: Route = {
      screen: state.route.screen,
      conversationId: state.route.conversationId,
      params: routeParamsFor(state),
    };
    state.route = next;
    writeRoute(host, next);
  };

  const context: ActionContext = {
    state,
    navigate: (screen, conversationId) => {
      state.route = {
        screen,
        conversationId,
        params: state.route.params,
      };
      syncUrl();
      render();
    },
    refresh: () => {
      syncUrl();
      render();
    },
  };

  const liveContext: LiveContext = {
    state,
    live: state.live,
    refresh: () => {
      render();
    },
    now: () => Date.now(),
    newKey: options.newKey ?? (() => `${String(Date.now())}-${String(Math.random()).slice(2, 10)}`),
  };

  const dispatch = (name: string, arg = ''): void => {
    // `live-*` actions reach the server, so they settle later and re-render
    // themselves. Everything else is the synchronous demo action table.
    const pending = runLiveAction(liveContext, name, arg);
    if (pending !== null) {
      void pending;
      return;
    }
    runAction(name, context, arg);
  };

  const onClick = (event: Event): void => {
    const target = closestWithAttr(event.target, 'data-act');
    if (target === null) {
      if (state.openMenu !== null) {
        state.openMenu = null;
        render();
      }
      return;
    }
    // A form control fires `input`/`change`, never a click-driven action.
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLTextAreaElement) return;
    // The scrim only closes when the click landed on the scrim itself.
    if (target.hasAttribute('data-scrim') && event.target !== target) return;
    event.preventDefault();
    dispatch(attrOf(target, 'data-act'), attrOf(target, 'data-arg'));
  };

  const onInput = (event: Event): void => {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLSelectElement) &&
      !(target instanceof HTMLTextAreaElement)
    ) {
      return;
    }
    const act = target.getAttribute('data-act');
    if (act === null) return;
    const formName = target.getAttribute('data-form');
    const arg = formName === null ? target.value : `${formName}:${target.value}`;
    dispatch(act, arg);
    if (formName !== null && target instanceof HTMLSelectElement) render();
  };

  /**
   * Escape unwinds exactly one layer, outermost first: dialog, then an open
   * menu, then whichever side zones are open. Without the ordering, dismissing
   * a dialog would also collapse the panel behind it.
   */
  const onKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    const target = keyboard.target;

    if (
      target instanceof HTMLElement &&
      target.classList.contains('list-resizer') &&
      (keyboard.key === 'ArrowLeft' || keyboard.key === 'ArrowRight')
    ) {
      // Arrow direction is physical; the column grows away from its inline
      // start, so RTL reverses which arrow widens it.
      const rtl = state.lang === 'ar';
      const widens = rtl ? keyboard.key === 'ArrowLeft' : keyboard.key === 'ArrowRight';
      event.preventDefault();
      dispatch('resize-list-step', widens ? 'inc' : 'dec');
      return;
    }

    if (keyboard.key !== 'Escape') return;
    if (state.dialog !== null) {
      event.preventDefault();
      dispatch('close-dialog');
      return;
    }
    if (state.openMenu !== null) {
      event.preventDefault();
      dispatch('close-menu');
      return;
    }
    if (state.viewsOpen || state.panelOpen || state.listOpen) {
      event.preventDefault();
      dispatch('close-overlays');
    }
  };

  /**
   * Pointer drag on the queue-list separator. Width is measured from the
   * column's own inline start, so the same arithmetic serves RTL and LTR
   * without a direction branch on the coordinate itself.
   */
  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    const handle = pointer.target;
    if (!(handle instanceof HTMLElement) || !handle.classList.contains('list-resizer')) return;
    const column = handle.closest('.zone--list');
    if (!(column instanceof HTMLElement)) return;
    event.preventDefault();
    const rtl = root.ownerDocument.documentElement.getAttribute('dir') === 'rtl';

    const move = (moveEvent: Event): void => {
      const box = column.getBoundingClientRect();
      const x = (moveEvent as PointerEvent).clientX;
      dispatch('resize-list', String(rtl ? box.right - x : x - box.left));
    };
    const stop = (): void => {
      root.ownerDocument.removeEventListener('pointermove', move);
      root.ownerDocument.removeEventListener('pointerup', stop);
      root.ownerDocument.removeEventListener('pointercancel', stop);
    };
    root.ownerDocument.addEventListener('pointermove', move);
    root.ownerDocument.addEventListener('pointerup', stop);
    root.ownerDocument.addEventListener('pointercancel', stop);
  };

  /**
   * The People screen is the only server-backed screen so far, so the session
   * is resolved when it is first opened rather than on boot. That keeps the
   * demo screens working with no API reachable, and means a workspace that
   * never opens People never makes a request.
   */
  const ensureLiveSession = (): void => {
    if (sessionRequested || state.route.screen !== 'people') {
      return;
    }
    sessionRequested = true;
    void loadSession(liveContext).then(() => loadPeopleScreen(liveContext));
  };

  const handleRoute = (route: Route): void => {
    applyRoute(state, route);
    if (!state.openTabs.includes(state.route.screen)) {
      state.openTabs = [...state.openTabs, state.route.screen];
    }
    if (state.route.screen === 'inbox' && state.route.conversationId === null) {
      const fallback = defaultConversationId(state);
      if (fallback !== null) {
        state.route = { ...state.route, conversationId: fallback };
      }
    }
    syncUrl();
    render();
    ensureLiveSession();
  };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('pointerdown', onPointerDown);
  const stopRouter = onRouteChange(host, handleRoute);

  handleRoute(readRoute(host));

  return {
    state,
    render,
    dispatch,
    destroy: () => {
      stopRouter();
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onInput);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('pointerdown', onPointerDown);
    },
  };
}
