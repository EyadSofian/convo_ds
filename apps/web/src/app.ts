import type { ActionContext } from './actions';
import { runAction } from './actions';
import { ApiClient, API_BASE_URL, csrfFromCookie, type FetchLike } from './api/client';
import { ChannelsApi } from './api/channels';
import { ContactsApi } from './api/contacts';
import { ConversationsApi } from './api/conversations';
import { MetadataApi } from './api/metadata';
import { CampaignsApi } from './api/campaigns';
import { AutomationsApi } from './api/automations';
import { SavedViewsApi } from './api/saved-views';
import { NotificationsApi } from './api/notifications';
import {
  disconnectedApi,
  disconnectedChannelsApi,
  disconnectedContactsApi,
  disconnectedConversationsApi,
  disconnectedMetadataApi,
  PeopleApi,
} from './api/people';
import { allowedScreens, landingScreen } from './live/ability';
import type { LiveContext } from './live/actions';
import { loadChannelsScreen, loadPeopleScreen, loadSession, loadSettingsScreen } from './live/actions';
import {
  loadInboxScreen,
  openConversation,
  startRealtime,
  stopRealtime,
} from './live/inbox-actions';
import { loadContactsScreen } from './live/contact-actions';
import { loadAnalyticsReport, loadCampaignsScreen, refreshCampaignReportExport } from './live/campaign-actions';
import { loadAutomationsScreen } from './live/automation-actions';
import type { EventSourceFactory } from './live/realtime';
import { runLiveAction } from './live/dispatch';
import { refreshNotificationCount, runNotificationAction } from './live/notification-actions';
import { createLiveState, renewLiveState } from './live/store';
import type { LiveState } from './live/store';
import { attrOf, closestWithAttr, replace } from './dom';
import type { PreferenceStore } from './preferences';
import { browserStore, readPreferences, writePreferences } from './preferences';
import type { Route, RouterHost, ScreenId } from './router';
import { onRouteChange, readRoute, writeRoute } from './router';
import type { AppState } from './state';
import { applyRoute, createState, NO_ANALYTICS_FILTERS, routeParamsFor } from './state';
import { renderAnalytics } from './ui/analytics-screen';
import { renderGate, renderPublicAuth } from './ui/auth';
import { renderBroadcasts } from './ui/campaigns-screen';
import { renderAutomations } from './ui/automations-screen';
import { renderChannels } from './ui/channels-screen';
import { renderContacts } from './ui/contacts-screen';
import { renderDialog } from './ui/dialogs';
import { renderInbox } from './ui/live-inbox';
import { renderPeople } from './ui/people-screen';
import { renderSettings } from './ui/settings-screen';
import { renderShell, renderToasts } from './ui/shell';

function renderScreen(state: AppState): HTMLElement {
  if (state.route.screen === 'contacts') return renderContacts(state);
  if (state.route.screen === 'channels') return renderChannels(state);
  if (state.route.screen === 'people') return renderPeople(state);
  if (state.route.screen === 'broadcasts') return renderBroadcasts(state);
  if (state.route.screen === 'automations') return renderAutomations(state);
  if (state.route.screen === 'analytics') return renderAnalytics(state);
  if (state.route.screen === 'settings') return renderSettings(state);
  return renderInbox(state);
}

/**
 * Whether the workspace may be drawn at all.
 *
 * The single boundary between a visitor and the product: a session the server
 * confirmed, and a company to work in. Until both are true nothing protected is
 * built — not hidden with CSS, not rendered off-screen, not built.
 */
export function workspaceOpen(state: AppState): boolean {
  return state.live.session.status === 'signed_in' && state.live.session.tenantId !== null;
}

export function renderApp(state: AppState): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (state.route.screen === 'accept-invitation' || state.route.screen === 'reset-password') {
    fragment.appendChild(renderPublicAuth(state));
    return fragment;
  }
  if (!workspaceOpen(state)) {
    fragment.appendChild(renderGate(state));
    return fragment;
  }
  fragment.appendChild(renderShell(state, renderScreen(state)));
  const dialog = renderDialog(state);
  if (dialog !== null) fragment.appendChild(dialog);
  const toasts = renderToasts(state);
  if (toasts !== null) fragment.appendChild(toasts);
  return fragment;
}

/**
 * The stream, opened by the browser.
 *
 * `withCredentials` because the session is a cookie and an `EventSource`
 * without it is an unauthenticated request that will be refused.
 */
export function browserEventSource(url: string): EventSource {
  return new EventSource(url, { withCredentials: true });
}

/** Whether two routes name the same thing, params included. */
function sameRoute(current: Route, next: Route): boolean {
  if (current.screen !== next.screen || current.conversationId !== next.conversationId) {
    return false;
  }
  const currentKeys = Object.keys(current.params);
  const nextKeys = Object.keys(next.params);
  return (
    currentKeys.length === nextKeys.length &&
    currentKeys.every((key) => current.params[key] === next.params[key])
  );
}

/* --------------------------------------------------------------- focus keep -- */

interface FocusSnapshot {
  readonly key: string;
  /**
   * Which control with that key, in document order. The same action and
   * argument legitimately appear twice, so the key alone would move focus
   * across the screen on re-render.
   */
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
}

function focusKeyOf(element: Element | null): string | null {
  if (!(element instanceof HTMLElement)) return null;
  const act = element.getAttribute('data-act');
  if (act === null) return element.id === '' ? null : `#${element.id}`;
  const arg = element.getAttribute('data-arg') ?? element.getAttribute('data-form') ?? '';
  return `${act}|${arg}`;
}

function keyedControls(root: Element, key: string): readonly Element[] {
  if (key.startsWith('#')) {
    return Array.from(root.querySelectorAll(key.replace(/[^#\w-]/g, '')));
  }
  return Array.from(root.querySelectorAll('[data-act]')).filter(
    (element) => focusKeyOf(element) === key,
  );
}

function captureFocus(root: Element): FocusSnapshot | null {
  const active = root.ownerDocument.activeElement;
  const key = focusKeyOf(active);
  if (key === null || active === null) return null;
  const ordinal = keyedControls(root, key).indexOf(active);
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return { key, ordinal, start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 };
  }
  return { key, ordinal, start: -1, end: -1 };
}

function restoreFocus(root: Element, snapshot: FocusSnapshot | null): boolean {
  if (snapshot === null) return false;
  const match = keyedControls(root, snapshot.key)[Math.max(snapshot.ordinal, 0)];
  if (!(match instanceof HTMLElement)) return false;
  match.focus();
  if (
    snapshot.start >= 0 &&
    (match instanceof HTMLInputElement || match instanceof HTMLTextAreaElement)
  ) {
    try {
      match.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      // `email` and `number` inputs have no selection API; focus is enough.
    }
  }
  return true;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter(
    (element): element is HTMLElement => element instanceof HTMLElement && rendered(element, container),
  );
}

/**
 * Whether the stylesheet draws a control at all. A control it hides — the
 * collapse toggle inside the phone-width drawer, say — is not a Tab stop, and
 * counting it as the layer's last one would let Tab walk out of the layer.
 */
function rendered(element: Element, container: Element): boolean {
  for (let node: Element | null = element; node !== null && node !== container; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * Which layer is on top, if any.
 *
 * Opening a layer moves focus into it and closing one returns focus to the
 * control that opened it. The order is the stacking order: a dialog sits over a
 * menu, which sits over a drawer.
 */
function overlayOf(state: AppState): string | null {
  if (!workspaceOpen(state)) return null;
  if (state.dialog !== null) return `dialog:${state.dialog.kind}`;
  if (state.openMenu !== null) return `menu:${state.openMenu}`;
  if (state.navOpen) return 'nav';
  return null;
}

/**
 * Sizes the composer to its content, between the resting and maximum heights
 * in `styles/tokens.css`. A textarea cannot size itself to content in CSS that
 * ships everywhere today, and a fixed `rows` count would either waste the
 * timeline's space at rest or clip a long reply.
 */
export const COMPOSER_MIN_HEIGHT = 44;
export const COMPOSER_MAX_HEIGHT = 120;

function growComposer(root: Element): void {
  const input = root.querySelector('.composer__input');
  if (input instanceof HTMLTextAreaElement) growField(input);
}

function growField(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  // `scrollHeight` excludes the border under `box-sizing: border-box`, so a
  // height set straight from it clips the text by the border width.
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

/** Cancels a scheduled callback. */
export type Cancel = () => void;
export type Scheduler = (work: () => void, delayMs: number) => Cancel;

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
  /** How the live stream is opened. Injected for the same reason `fetch` is. */
  readonly openEventSource?: EventSourceFactory | undefined;
  /** Where the theme and navigation width are remembered. Never anything else. */
  readonly preferences?: PreferenceStore | null | undefined;
  /** The system colour scheme, for a first visit with no stored choice. */
  readonly prefersDark?: (() => boolean) | undefined;
  /** How follow-up reads are delayed, e.g. an export still being prepared. */
  readonly schedule?: Scheduler | undefined;
}

/** How long to wait before asking again about an export that is still running. */
export const EXPORT_POLL_MS = 2500;

/**
 * Which screens load what.
 *
 * A table rather than a chain of `if`s because every screen reads the server
 * now, and one missing here is a screen that would silently show nothing.
 */
const SCREEN_LOADERS: Readonly<Record<Exclude<ScreenId, 'accept-invitation' | 'reset-password'>, (context: LiveContext) => Promise<void>>> = {
  people: loadPeopleScreen,
  channels: loadChannelsScreen,
  inbox: loadInboxScreen,
  contacts: loadContactsScreen,
  broadcasts: loadCampaignsScreen,
  automations: loadAutomationsScreen,
  analytics: loadAnalyticsReport,
  settings: loadSettingsScreen,
};

/**
 * Entry point: finds (or creates) the mount node and starts the app.
 */
export function boot(
  document_: Document,
  host: RouterHost & { readonly localStorage?: PreferenceStore; matchMedia?: (query: string) => { readonly matches: boolean } },
): AppHandle {
  const existing = document_.getElementById('app');
  const root = existing ?? document_.body.appendChild(document_.createElement('div'));
  root.id = 'app';
  return mount({
    root,
    host,
    fetch: (input, init) => globalThis.fetch(input, init),
    readCsrfToken: () => csrfFromCookie(document_.cookie),
    preferences: browserStore(host),
    prefersDark: () => host.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  });
}

/** `setTimeout`, cancellable. The default scheduler outside tests. */
export function browserScheduler(work: () => void, delayMs: number): Cancel {
  const handle = setTimeout(work, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

export function mount(options: MountOptions): AppHandle {
  const transport = options.fetch;
  const client =
    transport === undefined
      ? null
      : new ApiClient({
          baseUrl: API_BASE_URL,
          fetch: transport,
          readCsrfToken: options.readCsrfToken ?? (() => null),
          // A function declaration below, hoisted: the client is built before the
          // context it closes, and the hook only runs after a request has been sent.
          onUnauthenticated: expireWorkspace,
        });
  const api = client === null ? disconnectedApi() : new PeopleApi(client);
  const channels = client === null ? disconnectedChannelsApi() : new ChannelsApi(client);
  const conversations =
    client === null ? disconnectedConversationsApi() : new ConversationsApi(client);
  const contacts = client === null ? disconnectedContactsApi() : new ContactsApi(client);
  const metadata = client === null ? disconnectedMetadataApi() : new MetadataApi(client);
  const campaigns = client === null ? undefined : new CampaignsApi(client);
  const automations = client === null ? undefined : new AutomationsApi(client);
  const savedViews = client === null ? undefined : new SavedViewsApi(client);
  /**
   * The clock the whole screen reads. When `now` is supplied it is the clock —
   * frozen, and used for relative times *and* for any instant an action
   * computes. In production nothing is supplied and this is `new Date()`.
   */
  const clock = (): Date => options.now ?? new Date();
  const notifications = client === null ? null : new NotificationsApi(client);
  const state = createState(clock(), createLiveState(api, channels, conversations, contacts, metadata, campaigns, automations, savedViews, notifications));
  const store = options.preferences ?? null;
  const stored = readPreferences(store);
  state.theme = stored.theme ?? ((options.prefersDark?.() ?? false) ? 'dark' : 'light');
  state.navCollapsed = stored.navCollapsed ?? true;
  state.lang = stored.lang ?? state.lang;
  let savedTheme = state.theme;
  let savedNav = state.navCollapsed;
  let savedLang = state.lang;

  const root = options.root;
  const host = options.host;
  const schedule: Scheduler = options.schedule ?? browserScheduler;
  /** The screen whose lists have been loaded for the current session. */
  let loadedScreen: ScreenId | null = null;
  /** Whether the first render has happened. */
  let drawn = false;
  let overlay: string | null = null;
  let returnFocus: FocusSnapshot | null = null;
  let cancelPoll: Cancel | null = null;
  let destroyed = false;

  const syncUrl = (): void => {
    const next: Route = {
      screen: state.route.screen,
      conversationId: state.route.conversationId,
      params: routeParamsFor(state),
    };
    state.route = next;
    writeRoute(host, next);
  };

  const render = (): void => {
    // Relative times are a function of when the screen was drawn, so the clock
    // advances here rather than being read inside a view.
    state.clock = clock();
    const snapshot = captureFocus(root);
    const document_ = root.ownerDocument;
    document_.documentElement.setAttribute('lang', state.lang);
    document_.documentElement.setAttribute('dir', state.lang === 'ar' ? 'rtl' : 'ltr');
    document_.documentElement.setAttribute('data-theme', state.theme);
    if (state.theme !== savedTheme || state.navCollapsed !== savedNav || state.lang !== savedLang) {
      savedTheme = state.theme;
      savedNav = state.navCollapsed;
      savedLang = state.lang;
      writePreferences(store, { theme: state.theme, navCollapsed: state.navCollapsed, lang: state.lang });
    }
    root.className = 'app-root';
    replace(root, [renderApp(state)]);
    growComposer(root);

    const nextOverlay = overlayOf(state);
    if (nextOverlay !== overlay) {
      const opened = nextOverlay !== null;
      if (opened && overlay === null) returnFocus = snapshot;
      overlay = nextOverlay;
      if (opened) {
        // Every overlay carries one of the two markers, so an opened layer is there.
        const layer = root.querySelector('[data-trap], [data-overlay]') as HTMLElement;
        const first = focusables(layer)[0];
        if (first !== undefined) {
          first.focus();
          return;
        }
      } else if (restoreFocus(root, returnFocus)) {
        returnFocus = null;
        return;
      }
    }
    if (state.focusTarget !== null) {
      const target = root.querySelector(state.focusTarget);
      state.focusTarget = null;
      if (target instanceof HTMLElement) {
        target.focus();
        return;
      }
    }
    restoreFocus(root, snapshot);
  };

  /**
   * Draws, then makes sure the screen on show has its data.
   *
   * The load runs *before* the draw when it is needed: a load marks its lists
   * busy and re-renders synchronously, so the first frame of a newly opened
   * workspace is a loading state rather than whatever the lists held before.
   */
  const refresh = (): void => {
    if (destroyed) return;
    syncUrl();
    if (!ensureScreen()) render();
    followExport();
  };

  const makeContext = (live: LiveState): LiveContext => ({
    state,
    live,
    refresh,
    now: () => clock().getTime(),
    newKey: options.newKey ?? (() => `${String(Date.now())}-${String(Math.random()).slice(2, 10)}`),
    endSession: () => {
      closeWorkspace(false);
    },
    switchWorkspace: (tenantId) => {
      const session = state.live.session;
      stopRealtime(liveContext);
      cancelPoll?.();
      cancelPoll = null;
      state.live = renewLiveState(state.live);
      state.live.session = { ...session, tenantId } as typeof session;
      liveContext = makeContext(state.live);
      state.dialog = null;
      state.dialogForm = {};
      state.openMenu = null;
      state.analyticsFilters = NO_ANALYTICS_FILTERS;
      state.channelKind = '';
      state.expandedConnection = null;
      state.route = { ...state.route, conversationId: null };
      loadedScreen = null;
      refresh();
    },
  });
  let liveContext = makeContext(state.live);

  /**
   * Closes the workspace: stream, timers, drafts and every protected list.
   *
   * The route stays in the address bar, so signing back in lands where the
   * operator was. A deliberate sign-out drops the open conversation from it:
   * the next person to sign in on this browser has no business being sent to
   * somebody else's thread.
   */
  const closeWorkspace = (expired: boolean): void => {
    stopRealtime(liveContext);
    cancelPoll?.();
    cancelPoll = null;
    state.live = renewLiveState(state.live);
    state.live.session = expired
      ? { status: 'signed_out', error: null, expired: true }
      : { status: 'signed_out', error: null };
    liveContext = makeContext(state.live);
    state.dialog = null;
    state.dialogForm = {};
    state.formErrors = {};
    state.openMenu = null;
    state.navOpen = false;
    state.listOpen = false;
    state.toasts = [];
    state.passwordVisible = false;
    loadedScreen = null;
    if (!expired && state.route.conversationId !== null) {
      state.route = { ...state.route, conversationId: null };
      syncUrl();
    }
    render();
  };

  function expireWorkspace(): void {
    // Only a workspace that was open can expire. A 401 during the probe or on
    // the gate is the ordinary signed-out answer and is handled where it lands.
    if (workspaceOpen(state)) closeWorkspace(true);
  }

  const context: ActionContext = {
    state,
    navigate: (screen, conversationId) => {
      state.route = {
        screen,
        conversationId,
        params: state.route.params,
      };
      refresh();
    },
    refresh,
  };

  /**
   * Loads the current screen once per session, and keeps the route inside what
   * this membership can open.
   *
   * Returns whether it drew, so `refresh` does not draw a second time.
   */
  const ensureScreen = (): boolean => {
    if (state.route.screen === 'accept-invitation' || state.route.screen === 'reset-password') return false;
    if (!workspaceOpen(state)) return false;
    if (!allowedScreens(state.live).includes(state.route.screen)) {
      // A screen this membership cannot use is not offered in the navigation,
      // so a link to one lands on the first screen it can. The server still
      // refuses the data either way.
      state.route = { screen: landingScreen(state.live), conversationId: null, params: state.route.params };
      syncUrl();
    }
    const screen = state.route.screen as Exclude<ScreenId, 'accept-invitation' | 'reset-password'>;
    if (loadedScreen === screen) return false;
    loadedScreen = screen;
    const current = liveContext;
    const load = SCREEN_LOADERS[screen];
    let drew = false;
    const settled = load({ ...current, refresh: () => { drew = true; refresh(); } });
    void settled.then(() => {
      afterLoad(screen, current);
    });
    return drew;
  };

  /**
   * Follows a CSV export that is still being prepared, until it settles.
   *
   * A poll of a real endpoint, not a timer standing in for a result: each tick
   * asks the server, and "completed" is only drawn when the server says so.
   */
  const followExport = (): void => {
    const job = state.live.campaignReportExport;
    const pending =
      workspaceOpen(state) &&
      job.status === 'ready' &&
      (job.value.state === 'queued' || job.value.state === 'running');
    if (!pending) {
      cancelPoll?.();
      cancelPoll = null;
      return;
    }
    if (cancelPoll !== null) return;
    const current = liveContext;
    cancelPoll = schedule(() => {
      cancelPoll = null;
      void refreshCampaignReportExport(current);
    }, EXPORT_POLL_MS);
  };

  const dispatch = (name: string, arg = ''): void => {
    const notification = runNotificationAction(liveContext, name, arg);
    if (notification !== null) {
      void notification;
      return;
    }
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
      // A click inside an open popover is somebody using it, not dismissing it.
      const inside = event.target instanceof Element && event.target.closest('[data-overlay]') !== null;
      if (state.openMenu !== null && !inside) {
        state.openMenu = null;
        refresh();
      }
      return;
    }
    // A form control fires `input`/`change`, never a click-driven action.
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLTextAreaElement) return;
    // The scrim only closes when the click landed on the scrim itself.
    if (target.hasAttribute('data-scrim') && event.target !== target) return;
    const mouse = event as MouseEvent;
    // A navigation link opened in a new tab is the browser's business.
    if (target instanceof HTMLAnchorElement && (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey)) return;
    event.preventDefault();
    const act = attrOf(target, 'data-act');
    if (act === 'skip-to-content') {
      root.ownerDocument.getElementById('main')?.focus();
      return;
    }
    // A submit button's form already dispatches on `submit`.
    if (target instanceof HTMLButtonElement && target.type === 'submit' && target.form !== null) {
      target.form.requestSubmit();
      return;
    }
    dispatch(act, attrOf(target, 'data-arg'));
  };

  const onSubmit = (event: Event): void => {
    // Only a form fires `submit`.
    const form = event.target as HTMLFormElement;
    event.preventDefault();
    const act = form.getAttribute('data-submit');
    if (act !== null) dispatch(act, form.getAttribute('data-arg') ?? '');
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
    const previousInputValue = formName === null ? undefined : state.dialogForm[formName];
    dispatch(act, arg);
    const waParameter = target.getAttribute('data-wa-parameter');
    if (waParameter !== null) {
      if (previousInputValue !== target.value) delete state.dialogForm['whatsappTemplateClientMessageId'];
      for (const preview of root.querySelectorAll<HTMLElement>('[data-template-preview-key]')) {
        if (preview.getAttribute('data-template-preview-key') === waParameter) preview.textContent = target.value || `{{${waParameter.split(':').at(-1)!}}}`;
      }
    }
    if (formName !== null && target instanceof HTMLSelectElement && act === 'form') refresh();
    // A draft is recorded without a re-render, so the caret never jumps; the one
    // control its emptiness gates is updated in place instead. Without this the
    // Send button stayed disabled until something else happened to redraw.
    // The draft grows as it is typed, not only when something else redraws.
    if (target instanceof HTMLTextAreaElement && target.classList.contains('composer__input')) growField(target);
    const enables = target.getAttribute('data-enables');
    const gated = enables === null ? null : root.querySelector(`[data-act="${enables}"]`);
    if (gated instanceof HTMLButtonElement && gated.getAttribute('aria-busy') !== 'true') {
      gated.disabled = target.value.trim() === '';
    }
  };

  /**
   * Keeps Tab inside the top layer while it is modal. Every modal layer has at
   * least its own close button, so there is always a first and a last stop.
   */
  const trapTab = (keyboard: KeyboardEvent): boolean => {
    const layer = root.querySelector('[data-trap]') as HTMLElement;
    const items = focusables(layer);
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = root.ownerDocument.activeElement;
    if (keyboard.shiftKey && (active === first || !layer.contains(active))) {
      last.focus();
      return true;
    }
    if (!keyboard.shiftKey && (active === last || !layer.contains(active))) {
      first.focus();
      return true;
    }
    return false;
  };

  /** Arrow keys walk a menu's items; Home and End jump to its ends. */
  const moveInMenu = (keyboard: KeyboardEvent): void => {
    const menu = root.querySelector('[role="menu"]') as HTMLElement;
    const items = Array.from(menu.querySelectorAll('[role^="menuitem"]:not([disabled])')).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const index = items.indexOf(root.ownerDocument.activeElement as HTMLElement);
    const next =
      keyboard.key === 'Home'
        ? 0
        : keyboard.key === 'End'
          ? items.length - 1
          : keyboard.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    (items[next] as HTMLElement).focus();
  };

  /**
   * Escape unwinds exactly one layer, outermost first: dialog, menu, then the
   * navigation drawer, then the queue drawer.
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

    const mobileFilterDrawer = state.openMenu === 'inbox-filters' &&
      root.ownerDocument.defaultView?.matchMedia('(max-width: 599px)').matches === true;
    if (keyboard.key === 'Tab' && (state.dialog !== null || state.navOpen || mobileFilterDrawer)) {
      if (trapTab(keyboard)) event.preventDefault();
      return;
    }

    if (state.openMenu !== null && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(keyboard.key)) {
      event.preventDefault();
      moveInMenu(keyboard);
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
    if (state.navOpen) {
      event.preventDefault();
      dispatch('nav-drawer-close');
      return;
    }
    if (state.listOpen || state.panelDrawer) {
      event.preventDefault();
      dispatch('close-overlays');
    }
  };

  /**
   * Pointer drag on the queue-list separator. Width is measured from the
   * column's own inline start, so the same arithmetic serves RTL and LTR.
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
   * Opens the live stream for the signed-in workspace, including non-Inbox
   * routes, so a member's bell can update while they work elsewhere.
   */
  const afterLoad = (screen: ScreenId, loadedWith: LiveContext): void => {
    // The session this load belonged to has ended; its answers go nowhere.
    if (loadedWith !== liveContext || !workspaceOpen(state)) {
      return;
    }
    if (screen === 'inbox') {
      const deepLinked = state.route.conversationId;
      if (deepLinked !== null && state.live.openConversationId !== deepLinked) {
        void openConversation(liveContext, deepLinked);
      }
    }
    // The bell needs only a count at boot. Fetching the full drawer after the
    // route loads is unnecessary traffic and delays useful first content.
    if (state.live.notificationUnreadCount.status === 'idle') void refreshNotificationCount(liveContext);
    if (options.openEventSource === undefined && typeof EventSource === 'undefined') {
      state.live.realtime = { status: 'stopped', reason: 'unsupported_browser' };
      refresh();
      return;
    }
    startRealtime(liveContext, {
      baseUrl: API_BASE_URL,
      open: options.openEventSource ?? browserEventSource,
    });
  };

  /**
   * Applies a route and draws it. A route identical to the one on screen is not
   * redrawn: every URL sync fires the router's own listener.
   */
  const handleRoute = (route: Route): void => {
    if (drawn && sameRoute(state.route, route)) {
      return;
    }
    const firstDraw = !drawn;
    drawn = true;
    const previousScreen = state.route.screen;
    const previousRoute = state.route;
    applyRoute(state, route);
    if (!firstDraw && route.screen === 'analytics' && previousScreen === 'analytics') {
      // Back and forward through filter changes re-read the report they name.
      loadedScreen = null;
    }
    if (!firstDraw && route.screen === 'automations' && previousScreen === 'automations') {
      // Automation tabs and draft links are distinct server-backed resources.
      // A same-screen query change must load its list/editor data just like a
      // top-level navigation, otherwise the screen remains on its prior
      // skeleton/resource and the URL lies about the selected view.
      const viewChanged = previousRoute.params['view'] !== route.params['view'];
      const draftChanged = previousRoute.params['edit'] !== route.params['edit'];
      if (viewChanged || draftChanged) loadedScreen = null;
    }
    syncUrl();
    refresh();
  };

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('pointerdown', onPointerDown);
  const stopRouter = onRouteChange(host, handleRoute);

  handleRoute(readRoute(host));
  // The session is asked for once, at boot, before anything protected exists.
  // Until it answers the gate shows a loading screen and nothing else.
  void loadSession(liveContext);

  return {
    state,
    render,
    dispatch,
    destroy: () => {
      destroyed = true;
      stopRealtime(liveContext);
      cancelPoll?.();
      stopRouter();
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onInput);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('pointerdown', onPointerDown);
    },
  };
}
