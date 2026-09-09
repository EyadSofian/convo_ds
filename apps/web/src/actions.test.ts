import { beforeEach, describe, expect, it } from 'vitest';
import { nextTabAfterClose, runAction, selectedId } from './actions';
import type { ActionContext } from './actions';
import type { ScreenId } from './router';
import { createState, LIST_WIDTH_MAX, LIST_WIDTH_MIN } from './state';
import type { AppState } from './state';

/**
 * The workspace shell's action table.
 *
 * What used to live here — opening conversations, filtering a queue, composing
 * a reply — is gone with the demo inbox. The Inbox is served by `live-*`
 * actions that reach the API, and those are tested against a real server in
 * `live/live.test.ts`. What remains is the shell: tabs, theme, language, the
 * list drawer, dialogs and the three screens that are still seeded demos.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

interface Harness {
  state: AppState;
  context: ActionContext;
  navigations: { screen: ScreenId; conversationId: string | null }[];
  renders: number;
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
  } as Harness;
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
});

describe('navigation', () => {
  it('moves between screens and drops the conversation off the inbox', () => {
    runAction('nav', app.context, 'analytics');
    expect(app.navigations).toEqual([{ screen: 'analytics', conversationId: null }]);
  });

  it('ignores an unknown screen', () => {
    runAction('nav', app.context, 'nowhere');
    expect(app.navigations).toEqual([]);
  });

  it('opens a tab for each screen and keeps the inbox tab pinned', () => {
    runAction('nav', app.context, 'people');
    runAction('nav', app.context, 'channels');
    expect(app.state.openTabs).toEqual(['inbox', 'people', 'channels']);
  });

  it('closes a background tab without leaving the current screen', () => {
    runAction('nav', app.context, 'people');
    runAction('nav', app.context, 'channels');
    runAction('close-tab', app.context, 'people');
    expect(app.state.openTabs).toEqual(['inbox', 'channels']);
    expect(app.state.route.screen).toBe('channels');
  });

  it('falls back to the neighbouring tab when closing the active one', () => {
    runAction('nav', app.context, 'people');
    runAction('nav', app.context, 'channels');
    runAction('close-tab', app.context, 'channels');
    expect(app.state.route.screen).toBe('people');
  });

  it('returns to the inbox — with its conversation — when the first tab closes', () => {
    runAction('nav', app.context, 'people');
    app.state.route = { ...app.state.route, conversationId: 'cv-1' };
    runAction('close-tab', app.context, 'people');
    expect(app.navigations.at(-1)).toEqual({ screen: 'inbox', conversationId: 'cv-1' });
  });

  it('refuses to close the last tab, an unknown screen or an unopened tab', () => {
    runAction('close-tab', app.context, 'inbox');
    expect(app.state.openTabs).toEqual(['inbox']);
    runAction('nav', app.context, 'people');
    runAction('close-tab', app.context, 'nowhere');
    runAction('close-tab', app.context, 'analytics');
    expect(app.state.openTabs).toEqual(['inbox', 'people']);
  });

  it('names the landing tab for every shape of the remaining list', () => {
    expect(nextTabAfterClose(['inbox', 'people'], 1)).toBe('inbox');
    expect(nextTabAfterClose(['people'], 0)).toBe('people');
    // Unreachable through the UI — the last tab cannot be closed — and still
    // defined, because a function that indexes an array should say what it does
    // when there is nothing there.
    expect(nextTabAfterClose([], 0)).toBe('inbox');
  });

  it('names the conversation the inbox is showing when returning to it', () => {
    app.state.route = { ...app.state.route, conversationId: 'cv-1' };
    runAction('nav', app.context, 'inbox');
    // Navigating to the inbox carries whatever conversation the route already
    // names, so a reload or a back button lands on the same thread.
    expect(app.navigations.at(-1)).toEqual({ screen: 'inbox', conversationId: 'cv-1' });
    expect(selectedId(app.state)).toBe('cv-1');
  });
});

describe('chrome', () => {
  it('toggles the theme both ways', () => {
    runAction('theme', app.context, '');
    expect(app.state.theme).toBe('dark');
    runAction('theme', app.context, '');
    expect(app.state.theme).toBe('light');
  });

  it('switches language and role, and refuses an unknown role', () => {
    runAction('lang', app.context, 'en');
    expect(app.state.lang).toBe('en');
    runAction('lang', app.context, 'ar');
    expect(app.state.lang).toBe('ar');

    runAction('role', app.context, 'agent');
    expect(app.state.role).toBe('agent');
    runAction('role', app.context, 'wizard');
    expect(app.state.role).toBe('agent');
  });

  it('opens and closes a menu, and closes it when a role is picked', () => {
    runAction('menu', app.context, 'sort');
    expect(app.state.openMenu).toBe('sort');
    runAction('menu', app.context, 'sort');
    expect(app.state.openMenu).toBeNull();

    runAction('menu', app.context, 'role');
    runAction('role', app.context, 'agent');
    expect(app.state.openMenu).toBeNull();

    runAction('menu', app.context, 'sort');
    runAction('close-menu', app.context, '');
    expect(app.state.openMenu).toBeNull();
  });

  it('opens the list drawer and closes it from the scrim', () => {
    runAction('list', app.context, '');
    expect(app.state.listOpen).toBe(true);
    runAction('close-overlays', app.context, 'list');
    expect(app.state.listOpen).toBe(false);

    runAction('list', app.context, '');
    runAction('close-overlays', app.context, '');
    expect(app.state.listOpen).toBe(false);
  });

  it('closes the list drawer when navigating away', () => {
    runAction('list', app.context, '');
    runAction('nav', app.context, 'people');
    expect(app.state.listOpen).toBe(false);
  });

  it('resizes the list column and clamps at both ends', () => {
    runAction('resize-list', app.context, '340');
    expect(app.state.listWidth).toBe(340);
    runAction('resize-list', app.context, '10000');
    expect(app.state.listWidth).toBe(LIST_WIDTH_MAX);
    runAction('resize-list', app.context, '1');
    expect(app.state.listWidth).toBe(LIST_WIDTH_MIN);
    // A width that would not move it is not a change, so nothing re-renders.
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

  it('dismisses a toast', () => {
    runAction('campaign', app.context, `launch:${app.state.dataset.campaigns[0]?.id ?? ''}`);
    const toast = app.state.toasts[0];
    expect(toast).toBeDefined();
    runAction('toast', app.context, toast?.id ?? '');
    expect(app.state.toasts).toEqual([]);
  });

  it('says so out loud when a control is still a demo', () => {
    const fresh = harness();
    runAction('demo', fresh.context, '');
    // A demo control that did nothing silently would be indistinguishable from
    // one that is broken. It says which it is.
    expect(fresh.state.toasts[0]).toMatchObject({ tone: 'warning', text: 'إجراء تجريبي' });
    runAction('demo', fresh.context, 'Not wired yet');
    expect(fresh.state.toasts[1]?.text).toBe('Not wired yet');
  });
});

describe('dialogs', () => {
  it('opens with a kind and an argument, and clears the form each time', () => {
    runAction('dialog', app.context, 'member:m-1');
    expect(app.state.dialog).toEqual({ kind: 'member', arg: 'm-1' });
    runAction('form', app.context, 'name:Sara');
    expect(app.state.dialogForm.name).toBe('Sara');

    runAction('dialog', app.context, 'invite');
    expect(app.state.dialog).toEqual({ kind: 'invite', arg: '' });
    // A new dialog starts empty: carrying the last one's fields over is how a
    // value ends up submitted to a form nobody typed it into.
    expect(app.state.dialogForm).toEqual({});
  });

  it('closes and forgets what was typed', () => {
    runAction('dialog', app.context, 'invite');
    runAction('form', app.context, 'email:someone@example.test');
    runAction('close-dialog', app.context, '');
    expect(app.state.dialog).toBeNull();
    expect(app.state.dialogForm).toEqual({});
  });

  it('ignores a form value with no field name', () => {
    runAction('dialog', app.context, 'invite');
    runAction('form', app.context, 'no-separator');
    expect(app.state.dialogForm).toEqual({});
  });

  it('re-renders for a toggle but not for ordinary typing', () => {
    runAction('dialog', app.context, 'invite');
    const before = app.renders;
    runAction('form', app.context, 'email:a');
    // Redrawing on every keystroke moves the caret.
    expect(app.renders).toBe(before);
    runAction('form-toggle', app.context, 'notify:on');
    expect(app.renders).toBeGreaterThan(before);
  });
});

describe('campaign actions', () => {
  it('refuses to launch a campaign that is ready but not approved', () => {
    const campaign = app.state.dataset.campaigns.find((entry) => !entry.approved);
    expect(campaign).toBeDefined();
    runAction('campaign', app.context, `launch:${campaign?.id ?? ''}`);
    // "Ready" is not "approved": approval is a separate, revision-bound record.
    expect(app.state.toasts[0]?.tone).toBe('danger');
  });

  it('refuses to edit a campaign that has already launched', () => {
    const campaign = app.state.dataset.campaigns.find(
      (entry) => entry.state !== 'draft' && entry.state !== 'ready',
    );
    expect(campaign).toBeDefined();
    runAction('campaign', app.context, `edit:${campaign?.id ?? ''}`);
    expect(app.state.toasts[0]?.tone).toBe('danger');
  });

  it('ignores a campaign that does not exist', () => {
    runAction('campaign', app.context, 'launch:cp-nope');
    expect(app.state.toasts).toEqual([]);
    // A verb with no id at all is the same non-answer.
    runAction('campaign', app.context, 'launch');
    expect(app.state.toasts).toEqual([]);
  });

  it('says a permitted action is a demo rather than pretending it ran', () => {
    const campaign = app.state.dataset.campaigns.find((entry) => entry.approved);
    expect(campaign).toBeDefined();
    runAction('campaign', app.context, `launch:${campaign?.id ?? ''}`);
    expect(app.state.toasts[0]).toMatchObject({ tone: 'warning' });
    expect(app.state.toasts[0]?.text).toContain('لا يُرسل شيء إلى أي مزوّد');
  });

  it('writes every campaign answer in English too', () => {
    app.state.lang = 'en';
    const unapproved = app.state.dataset.campaigns.find((entry) => !entry.approved);
    const launched = app.state.dataset.campaigns.find(
      (entry) => entry.state !== 'draft' && entry.state !== 'ready',
    );
    const approved = app.state.dataset.campaigns.find((entry) => entry.approved);
    runAction('campaign', app.context, `launch:${unapproved?.id ?? ''}`);
    runAction('campaign', app.context, `edit:${launched?.id ?? ''}`);
    runAction('campaign', app.context, `launch:${approved?.id ?? ''}`);
    expect(app.state.toasts.map((toast) => toast.text)).toEqual([
      'Launch rejected — “ready” is not “approved”. Approval is a separate revision-bound record.',
      'Edits are rejected after launch — clone to a new campaign ID',
      'Demo action — nothing is sent to any provider',
    ]);
  });

  it('names a demo control in English too', () => {
    app.state.lang = 'en';
    runAction('demo', app.context, '');
    expect(app.state.toasts[0]?.text).toBe('Demo action');
  });
});
