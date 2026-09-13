import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelConnection } from './api/channels';
import { ACTIONS, runAction, selectedId } from './actions';
import type { ActionContext } from './actions';
import type { ScreenId } from './router';
import { createState, LIST_WIDTH_MAX, LIST_WIDTH_MIN, NO_ANALYTICS_FILTERS, pushToast } from './state';
import type { AppState } from './state';

/**
 * The view-choice half of the action table: navigation, theme, language,
 * drawers, dialogs and the local selections the screens remember. None of these
 * reach the server — the server-backed actions are exercised against a scripted
 * API in `live/*.test.ts`.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

interface Harness {
  state: AppState;
  context: ActionContext;
  navigations: { screen: ScreenId; conversationId: string | null }[];
  readonly renders: number;
}

function harness(): Harness {
  const state = createState(NOW);
  const navigations: { screen: ScreenId; conversationId: string | null }[] = [];
  let renders = 0;
  const context: ActionContext = {
    state,
    navigate: (screen, conversationId) => {
      navigations.push({ screen, conversationId });
      state.route = { ...state.route, screen, conversationId };
    },
    refresh: () => {
      renders += 1;
    },
  };
  return {
    state,
    context,
    navigations,
    get renders() {
      return renders;
    },
  };
}

function connection(id: string, kind: ChannelConnection['kind'], disconnected = false): ChannelConnection {
  return { id, kind, disconnected_at: disconnected ? NOW.toISOString() : null } as ChannelConnection;
}

let app: Harness;

beforeEach(() => {
  app = harness();
});

describe('runAction', () => {
  it('reports an unknown action instead of throwing', () => {
    expect(runAction('no-such-action', app.context, '')).toBe(false);
    expect(runAction('theme', app.context, '')).toBe(true);
  });

  it('has no role switch, demo action or seeded campaign action left in it', () => {
    for (const removed of ['role', 'demo', 'campaign', 'close-tab']) {
      expect(ACTIONS[removed]).toBeUndefined();
    }
  });
});

describe('navigation', () => {
  it('moves between screens and drops the conversation off every other screen', () => {
    runAction('nav', app.context, 'analytics');
    expect(app.navigations).toEqual([{ screen: 'analytics', conversationId: null }]);
  });

  it('ignores an unknown screen', () => {
    runAction('nav', app.context, 'nowhere');
    expect(app.navigations).toEqual([]);
  });

  it('closes the navigation drawer, any menu and the queue drawer on the way', () => {
    app.state.navOpen = true;
    app.state.openMenu = 'user';
    app.state.listOpen = true;
    runAction('nav', app.context, 'people');
    expect(app.state.navOpen).toBe(false);
    expect(app.state.openMenu).toBeNull();
    expect(app.state.listOpen).toBe(false);
  });

  it('keeps the conversation the inbox is showing when returning to it', () => {
    app.state.route = { ...app.state.route, conversationId: 'cv-1' };
    runAction('nav', app.context, 'inbox');
    expect(app.navigations.at(-1)).toEqual({ screen: 'inbox', conversationId: 'cv-1' });
    expect(selectedId(app.state)).toBe('cv-1');
  });

  it('collapses and expands the navigation, and sets it explicitly', () => {
    runAction('nav-collapse', app.context, '');
    expect(app.state.navCollapsed).toBe(false);
    runAction('nav-collapse', app.context, '');
    expect(app.state.navCollapsed).toBe(true);
    runAction('nav-set', app.context, 'expanded');
    expect(app.state.navCollapsed).toBe(false);
    runAction('nav-set', app.context, 'collapsed');
    expect(app.state.navCollapsed).toBe(true);
    const before = app.renders;
    runAction('nav-set', app.context, 'sideways');
    expect(app.renders).toBe(before);
  });

  it('opens the navigation drawer over any menu, and closes it', () => {
    app.state.openMenu = 'user';
    runAction('nav-drawer', app.context, '');
    expect(app.state.navOpen).toBe(true);
    expect(app.state.openMenu).toBeNull();
    runAction('nav-drawer-close', app.context, '');
    expect(app.state.navOpen).toBe(false);
  });
});

describe('chrome', () => {
  it('toggles the theme both ways, and sets it explicitly', () => {
    runAction('theme', app.context, '');
    expect(app.state.theme).toBe('dark');
    runAction('theme', app.context, '');
    expect(app.state.theme).toBe('light');
    runAction('theme-set', app.context, 'dark');
    expect(app.state.theme).toBe('dark');
    runAction('theme-set', app.context, 'sepia');
    expect(app.state.theme).toBe('dark');
  });

  it('switches language and closes the menu it was chosen from', () => {
    app.state.openMenu = 'user';
    runAction('lang', app.context, 'en');
    expect(app.state.lang).toBe('en');
    expect(app.state.openMenu).toBeNull();
    runAction('lang', app.context, 'fr');
    expect(app.state.lang).toBe('ar');
  });

  it('opens and closes a menu', () => {
    runAction('menu', app.context, 'user');
    expect(app.state.openMenu).toBe('user');
    runAction('menu', app.context, 'user');
    expect(app.state.openMenu).toBeNull();
    runAction('menu', app.context, 'tenant');
    runAction('close-menu', app.context, '');
    expect(app.state.openMenu).toBeNull();
  });

  it('dismisses a toast', () => {
    pushToast(app.state, 'Saved');
    const toast = app.state.toasts[0];
    runAction('toast', app.context, toast?.id ?? '');
    expect(app.state.toasts).toEqual([]);
  });

  it('shows and hides the sign-in password', () => {
    runAction('password-visibility', app.context, '');
    expect(app.state.passwordVisible).toBe(true);
    runAction('password-visibility', app.context, '');
    expect(app.state.passwordVisible).toBe(false);
  });
});

describe('inbox zones', () => {
  it('opens the list drawer and closes it from the scrim or Escape', () => {
    runAction('list', app.context, '');
    expect(app.state.listOpen).toBe(true);
    runAction('close-overlays', app.context, 'list');
    expect(app.state.listOpen).toBe(false);
    runAction('list', app.context, '');
    runAction('close-overlays', app.context, '');
    expect(app.state.listOpen).toBe(false);
  });

  it('keeps the inline panel preference apart from the panel drawer', () => {
    runAction('panel', app.context, '');
    expect(app.state.panelOpen).toBe(false);
    runAction('panel', app.context, '');
    expect(app.state.panelOpen).toBe(true);

    runAction('panel-drawer', app.context, '');
    expect(app.state.panelDrawer).toBe(true);
    runAction('close-overlays', app.context, 'panel-drawer');
    expect(app.state.panelDrawer).toBe(false);
    expect(app.state.panelOpen).toBe(true);

    runAction('panel-drawer', app.context, '');
    runAction('close-overlays', app.context, '');
    expect(app.state.panelDrawer).toBe(false);

    // The panel's own close button hides it in both arrangements.
    runAction('panel-drawer', app.context, '');
    runAction('close-overlays', app.context, 'panel');
    expect(app.state.panelOpen).toBe(false);
    expect(app.state.panelDrawer).toBe(false);
  });

  it('switches the composer between a reply and a private note', () => {
    runAction('composer-tab', app.context, 'note');
    expect(app.state.composerTab).toBe('note');
    runAction('composer-tab', app.context, 'reply');
    expect(app.state.composerTab).toBe('reply');
    runAction('composer-tab', app.context, 'sms');
    expect(app.state.composerTab).toBe('reply');
  });

  it('resizes the list column and clamps at both ends', () => {
    runAction('resize-list', app.context, '340');
    expect(app.state.listWidth).toBe(340);
    runAction('resize-list', app.context, '10000');
    expect(app.state.listWidth).toBe(LIST_WIDTH_MAX);
    runAction('resize-list', app.context, '1');
    expect(app.state.listWidth).toBe(LIST_WIDTH_MIN);
    const before = app.renders;
    runAction('resize-list', app.context, '1');
    runAction('resize-list', app.context, 'not-a-number');
    expect(app.renders).toBe(before);
  });

  it('steps the width with the keyboard, and stops at the clamp', () => {
    const start = app.state.listWidth;
    runAction('resize-list-step', app.context, 'inc');
    expect(app.state.listWidth).toBe(start + 8);
    runAction('resize-list-step', app.context, 'dec');
    expect(app.state.listWidth).toBe(start);
    runAction('resize-list-step', app.context, 'sideways');
    expect(app.state.listWidth).toBe(start);
    app.state.listWidth = LIST_WIDTH_MAX;
    runAction('resize-list-step', app.context, 'inc');
    expect(app.state.listWidth).toBe(LIST_WIDTH_MAX);
  });
});

describe('dialogs and forms', () => {
  it('opens with a kind and an argument, and clears the form and the last refusal', () => {
    app.state.live.error = { code: 'x', message: 'x', requestId: null, status: 400, details: [] };
    runAction('dialog', app.context, 'connect-channel:whatsapp');
    expect(app.state.dialog).toEqual({ kind: 'connect-channel', arg: 'whatsapp' });
    expect(app.state.live.error).toBeNull();
    runAction('form', app.context, 'channelName:Admissions');
    expect(app.state.dialogForm['channelName']).toBe('Admissions');
    runAction('dialog', app.context, 'invite');
    expect(app.state.dialog).toEqual({ kind: 'invite', arg: '' });
    expect(app.state.dialogForm).toEqual({});
  });

  it('closes and forgets what was typed', () => {
    runAction('dialog', app.context, 'invite');
    runAction('form', app.context, 'inviteEmail:someone@example.test');
    app.state.live.error = { code: 'x', message: 'x', requestId: null, status: 400, details: [] };
    runAction('close-dialog', app.context, '');
    expect(app.state.dialog).toBeNull();
    expect(app.state.dialogForm).toEqual({});
    expect(app.state.live.error).toBeNull();
  });

  it('ignores a form value with no field name', () => {
    runAction('form', app.context, 'no-separator');
    expect(app.state.dialogForm).toEqual({});
  });

  it('re-renders for a gating field but not for ordinary typing', () => {
    const before = app.renders;
    runAction('form', app.context, 'email:a');
    expect(app.renders).toBe(before);
    runAction('form-toggle', app.context, 'channelToken_c:abc');
    expect(app.renders).toBeGreaterThan(before);
  });
});

describe('channels', () => {
  it('narrows the connected list to a kind and collapses what was open', () => {
    app.state.expandedConnection = 'c-1';
    runAction('channel-kind', app.context, 'instagram');
    expect(app.state.channelKind).toBe('instagram');
    expect(app.state.expandedConnection).toBeNull();
  });

  it('expands and collapses one connection', () => {
    runAction('connection-toggle', app.context, 'c-1');
    expect(app.state.expandedConnection).toBe('c-1');
    runAction('connection-toggle', app.context, 'c-1');
    expect(app.state.expandedConnection).toBeNull();
  });

  it('manages a named connection, the first live one of a kind, or none', () => {
    app.state.live.connections = {
      status: 'ready',
      loadedAt: 1,
      value: [connection('gone', 'whatsapp', true), connection('wa-1', 'whatsapp'), connection('ig-1', 'instagram')],
    };
    runAction('channel-manage', app.context, 'instagram:ig-1');
    expect(app.state).toMatchObject({ channelKind: 'instagram', expandedConnection: 'ig-1' });
    expect(app.state.focusTarget).toBe('[data-connection="ig-1"] [data-act="connection-toggle"]');

    runAction('channel-manage', app.context, 'whatsapp:');
    expect(app.state.expandedConnection).toBe('wa-1');

    runAction('channel-manage', app.context, 'messenger');
    expect(app.state).toMatchObject({ channelKind: 'messenger', expandedConnection: null, focusTarget: null });

    app.state.live.connections = { status: 'loading' };
    runAction('channel-manage', app.context, 'whatsapp:');
    expect(app.state.expandedConnection).toBeNull();
  });
});

describe('campaigns and reports', () => {
  it('opens a campaign’s report narrowed to that campaign', () => {
    app.state.analyticsFilters = { from: '2026-01-01', to: '', channel: 'whatsapp', campaignId: '' };
    runAction('campaign-report', app.context, 'c-7');
    expect(app.state.analyticsFilters).toEqual({ ...NO_ANALYTICS_FILTERS, campaignId: 'c-7' });
    expect(app.navigations.at(-1)).toEqual({ screen: 'analytics', conversationId: null });
  });

  it('opens a report row’s campaign, selected, with its recipients not yet asked for', () => {
    app.state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: [] };
    runAction('campaign-open', app.context, 'c-7');
    expect(app.state.live.selectedCampaignId).toBe('c-7');
    expect(app.state.live.campaignRecipients).toEqual({ status: 'idle' });
    expect(app.navigations.at(-1)).toEqual({ screen: 'broadcasts', conversationId: null });
  });
});
