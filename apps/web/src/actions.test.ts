import { describe, expect, it } from 'vitest';
import type { ActionContext } from './actions';
import { runAction, selectedId, windowMinutesLeft } from './actions';
import { CURRENT_MEMBER_ID } from './data';
import type { AppState } from './state';
import { createState, findConversation, readDraft, writeDraft } from './state';

const NOW = new Date('2026-09-08T12:00:00.000Z');

interface Harness {
  readonly state: AppState;
  readonly context: ActionContext;
  run(name: string, arg?: string): boolean;
  readonly renders: () => number;
  readonly navigations: () => { screen: string; id: string | null }[];
}

function harness(conversationId: string | null = 'cv-4821'): Harness {
  const state = createState(NOW);
  state.route = { screen: 'inbox', conversationId, params: {} };
  let renders = 0;
  const navigations: { screen: string; id: string | null }[] = [];
  const context: ActionContext = {
    state,
    navigate: (screen, id) => {
      const next = id === undefined ? null : id;
      navigations.push({ screen, id: next });
      state.route = { screen, conversationId: next, params: {} };
      renders += 1;
    },
    refresh: () => {
      renders += 1;
    },
  };
  return {
    state,
    context,
    run: (name, arg = '') => runAction(name, context, arg),
    renders: () => renders,
    navigations: () => navigations,
  };
}

function lastToast(state: AppState): string {
  return state.toasts[state.toasts.length - 1]?.text ?? '';
}

describe('runAction', () => {
  it('reports an unknown action instead of throwing', () => {
    const app = harness();
    expect(app.run('does-not-exist')).toBe(false);
    expect(app.run('nav', 'people')).toBe(true);
  });
});

describe('navigation', () => {
  it('moves between screens and drops the conversation off the inbox', () => {
    const app = harness();
    app.run('nav', 'analytics');
    expect(app.navigations()).toContainEqual({ screen: 'analytics', id: null });
    app.run('nav', 'inbox');
    expect(app.state.route.screen).toBe('inbox');
  });

  it('ignores an unknown screen', () => {
    const app = harness();
    app.run('nav', 'nowhere');
    expect(app.navigations()).toHaveLength(0);
  });

  it('opens a tab for each screen and keeps the inbox tab pinned', () => {
    const app = harness();
    expect(app.state.openTabs).toEqual(['inbox']);
    app.run('nav', 'analytics');
    app.run('nav', 'people');
    expect(app.state.openTabs).toEqual(['inbox', 'analytics', 'people']);
    app.run('nav', 'analytics');
    expect(app.state.openTabs).toEqual(['inbox', 'analytics', 'people']);
  });

  it('closes a background tab without leaving the current screen', () => {
    const app = harness();
    app.run('nav', 'analytics');
    app.run('nav', 'people');
    app.run('close-tab', 'analytics');
    expect(app.state.openTabs).toEqual(['inbox', 'people']);
    expect(app.state.route.screen).toBe('people');
  });

  it('falls back to the neighbouring tab when closing the active one', () => {
    const app = harness();
    app.run('nav', 'analytics');
    app.run('nav', 'people');
    app.run('close-tab', 'people');
    expect(app.state.openTabs).toEqual(['inbox', 'analytics']);
    expect(app.state.route.screen).toBe('analytics');
  });

  it('returns to the inbox — with its conversation — when the first tab closes', () => {
    const app = harness();
    app.run('nav', 'channels');
    app.run('close-tab', 'inbox');
    expect(app.state.openTabs).toEqual(['channels']);
    expect(app.state.route.screen).toBe('channels');
  });

  it('refuses to close the last tab, an unknown screen or an unopened tab', () => {
    const app = harness();
    app.run('close-tab', 'inbox');
    expect(app.state.openTabs).toEqual(['inbox']);
    app.run('nav', 'people');
    app.run('close-tab', 'nowhere');
    app.run('close-tab', 'settings');
    expect(app.state.openTabs).toEqual(['inbox', 'people']);
  });

  it('opens a conversation and advances this user’s read cursor', () => {
    const app = harness(null);
    expect(findConversation(app.state, 'cv-4817')?.unreadCount).toBeGreaterThan(0);
    app.run('open', 'cv-4817');
    expect(selectedId(app.state)).toBe('cv-4817');
    expect(findConversation(app.state, 'cv-4817')?.unreadCount).toBe(0);
  });

  it('does not mark a queue card read, because there is nothing readable', () => {
    const app = harness(null);
    app.state.role = 'agent';
    app.run('open', 'cv-4817');
    expect(findConversation(app.state, 'cv-4817')?.unreadCount).toBeGreaterThan(0);
  });

  it('ignores an unknown conversation', () => {
    const app = harness(null);
    app.run('open', 'cv-nope');
    expect(selectedId(app.state)).toBeNull();
  });
});

describe('filters', () => {
  it('sets the queue segment and clears any active view', () => {
    const app = harness();
    app.state.activeViewId = 'v-sla';
    app.run('queue', 'unread');
    expect(app.state.filter.queue).toBe('unread');
    expect(app.state.activeViewId).toBeNull();
    app.run('queue', 'nope');
    expect(app.state.filter.queue).toBe('unread');
  });

  it('sets the sort order and closes the menu', () => {
    const app = harness();
    app.state.openMenu = 'f-sort';
    app.run('sort', 'sla');
    expect(app.state.filter.sort).toBe('sla');
    expect(app.state.openMenu).toBeNull();
    app.run('sort', 'nope');
    expect(app.state.filter.sort).toBe('sla');
  });

  it('sets the search query and the date window', () => {
    const app = harness();
    app.run('search', 'شحن');
    expect(app.state.filter.query).toBe('شحن');
    app.run('date', 'week');
    expect(app.state.filter.date).toBe('week');
    app.run('date', 'nope');
    expect(app.state.filter.date).toBe('week');
  });

  it('toggles a keyed filter and rejects malformed or unknown keys', () => {
    const app = harness();
    app.run('toggle-filter', 'channels:whatsapp');
    expect(app.state.filter.channels).toEqual(['whatsapp']);
    app.run('toggle-filter', 'channels:whatsapp');
    expect(app.state.filter.channels).toEqual([]);
    app.run('toggle-filter', 'nokey');
    app.run('toggle-filter', 'bogus:value');
    expect(app.state.filter.channels).toEqual([]);
  });

  it('clears every filter, and resets the whole inbox view', () => {
    const app = harness();
    app.run('toggle-filter', 'labels:lb-vip');
    app.run('search', 'x');
    app.run('clear-filters');
    expect(app.state.filter.labels).toEqual([]);
    expect(app.state.filter.query).toBe('');
    app.run('queue', 'mine');
    app.run('preview', 'offline');
    app.run('reset-inbox');
    expect(app.state.filter.queue).toBe('all');
    expect(app.state.preview).toBe('ready');
  });

  it('applies and ignores saved views', () => {
    const app = harness();
    app.run('view', 'v-vip');
    expect(app.state.activeViewId).toBe('v-vip');
    expect(app.state.filter.labels).toEqual(['lb-vip']);
    app.run('view', 'v-nope');
    expect(app.state.activeViewId).toBe('v-vip');
  });
});

describe('chrome', () => {
  it('toggles menus, groups, the panel and the list drawer', () => {
    const app = harness();
    app.run('menu', 'f-status');
    expect(app.state.openMenu).toBe('f-status');
    app.run('menu', 'f-status');
    expect(app.state.openMenu).toBeNull();
    app.run('menu', 'f-status');
    app.run('close-menu');
    expect(app.state.openMenu).toBeNull();
    app.run('group', 'g-teams');
    expect(app.state.collapsedGroups).toEqual(['g-teams']);
    app.run('group', 'g-teams');
    expect(app.state.collapsedGroups).toEqual([]);
    app.run('panel');
    expect(app.state.panelOpen).toBe(true);
    app.run('panel');
    expect(app.state.panelOpen).toBe(false);
    app.run('list');
    expect(app.state.listOpen).toBe(true);
    app.run('sidebar');
    expect(app.state.viewsOpen).toBe(true);
    app.run('sidebar');
    expect(app.state.viewsOpen).toBe(false);
  });

  it('toggles the theme both ways', () => {
    const app = harness();
    expect(app.state.theme).toBe('light');
    app.run('theme');
    expect(app.state.theme).toBe('dark');
    app.run('theme');
    expect(app.state.theme).toBe('light');
  });

  it('opens the sidebar from closed, and leaves the list drawer alone', () => {
    const app = harness();
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.listOpen).toBe(false);
    app.run('sidebar');
    expect(app.state.viewsOpen).toBe(true);
    // The list drawer is a narrow-viewport concern of its own; opening Views
    // no longer drags it along, which is what made the two fight on tablets.
    expect(app.state.listOpen).toBe(false);
    app.run('sidebar');
    expect(app.state.viewsOpen).toBe(false);
  });

  it('closes every overlay at once, and one at a time', () => {
    const app = harness();
    app.run('sidebar');
    app.run('panel');
    app.run('list');
    app.run('close-overlays');
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.panelOpen).toBe(false);
    expect(app.state.listOpen).toBe(false);

    app.run('sidebar');
    app.run('panel');
    app.run('close-overlays', 'views');
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.panelOpen).toBe(true);
    app.run('close-overlays', 'panel');
    expect(app.state.panelOpen).toBe(false);
    app.run('list');
    app.run('close-overlays', 'list');
    expect(app.state.listOpen).toBe(false);
  });

  it('focus mode closes both side zones and yields to either reopening', () => {
    const app = harness();
    app.run('sidebar');
    app.run('panel');
    app.run('focus');
    expect(app.state.focusMode).toBe(true);
    expect(app.state.viewsOpen).toBe(false);
    expect(app.state.panelOpen).toBe(false);
    app.run('focus');
    expect(app.state.focusMode).toBe(false);
  });

  it('switches language, preview state and role', () => {
    const app = harness();
    app.run('lang', 'en');
    expect(app.state.lang).toBe('en');
    app.run('lang', 'ar');
    expect(app.state.lang).toBe('ar');
    app.run('preview', 'denied');
    expect(app.state.preview).toBe('denied');
    app.run('preview', 'nope');
    expect(app.state.preview).toBe('denied');
    app.run('role', 'agent');
    expect(app.state.role).toBe('agent');
    app.run('role', 'owner');
    expect(app.state.role).toBe('agent');
  });

  it('dismisses a toast', () => {
    const app = harness();
    app.run('send');
    const id = app.state.toasts[0]?.id ?? '';
    app.run('toast', id);
    expect(app.state.toasts).toHaveLength(0);
  });
});

describe('composer', () => {
  it('switches tabs and records drafts per tab', () => {
    const app = harness();
    app.run('composer-input', 'مرحبًا');
    expect(readDraft(app.state, 'cv-4821', 'reply')).toBe('مرحبًا');
    app.run('composer-tab', 'note');
    expect(app.state.composerTab).toBe('note');
    app.run('composer-input', 'ملاحظة');
    expect(readDraft(app.state, 'cv-4821', 'note')).toBe('ملاحظة');
    expect(readDraft(app.state, 'cv-4821', 'reply')).toBe('مرحبًا');
    app.run('composer-tab', 'reply');
    expect(app.state.composerTab).toBe('reply');
  });

  it('ignores composer input with no conversation selected', () => {
    const app = harness(null);
    app.run('composer-input', 'x');
    app.run('send');
    app.run('insert', 'x');
    expect(app.state.toasts).toHaveLength(0);
  });

  it('refuses to send an empty draft', () => {
    const app = harness();
    app.run('send');
    expect(lastToast(app.state)).toContain('اكتب');
    expect(app.state.toasts[0]?.tone).toBe('warning');
  });

  it('sends a public reply and updates the snippet and read state', () => {
    const app = harness();
    writeDraft(app.state, 'cv-4821', 'reply', '  تم فتح بلاغ جديد  ');
    app.run('send');
    const items = app.state.timelines['cv-4821'] ?? [];
    const last = items[items.length - 1];
    expect(last?.kind).toBe('message');
    expect(findConversation(app.state, 'cv-4821')?.snippet).toBe('تم فتح بلاغ جديد');
    expect(findConversation(app.state, 'cv-4821')?.snippetDirection).toBe('out');
    expect(findConversation(app.state, 'cv-4821')?.unreadCount).toBe(0);
    expect(readDraft(app.state, 'cv-4821', 'reply')).toBe('');
  });

  it('adds a private note without touching the customer-visible snippet', () => {
    const app = harness();
    const before = findConversation(app.state, 'cv-4821')?.snippet;
    app.run('composer-tab', 'note');
    writeDraft(app.state, 'cv-4821', 'note', 'ملاحظة داخلية');
    app.run('send');
    const items = app.state.timelines['cv-4821'] ?? [];
    expect(items[items.length - 1]?.kind).toBe('note');
    expect(findConversation(app.state, 'cv-4821')?.snippet).toBe(before);
  });

  it('rejects a reply outside the channel window and keeps the draft', () => {
    const app = harness('cv-4809');
    expect(windowMinutesLeft(app.state, 'cv-4809')).toBeLessThanOrEqual(0);
    writeDraft(app.state, 'cv-4809', 'reply', 'رد متأخر');
    const before = (app.state.timelines['cv-4809'] ?? []).length;
    app.run('send');
    expect(app.state.toasts[0]?.tone).toBe('danger');
    expect(readDraft(app.state, 'cv-4809', 'reply')).toBe('رد متأخر');
    expect((app.state.timelines['cv-4809'] ?? []).length).toBe(before);
  });

  it('explains the closed window in English and still keeps the draft', () => {
    const app = harness('cv-4809');
    app.run('lang', 'en');
    writeDraft(app.state, 'cv-4809', 'reply', 'late reply');
    app.run('send');
    expect(lastToast(app.state)).toContain('The channel window has expired');
    expect(readDraft(app.state, 'cv-4809', 'reply')).toBe('late reply');
  });

  it('allows a private note even when the window is closed', () => {
    const app = harness('cv-4809');
    app.run('composer-tab', 'note');
    writeDraft(app.state, 'cv-4809', 'note', 'متابعة داخلية');
    app.run('send');
    const items = app.state.timelines['cv-4809'] ?? [];
    expect(items[items.length - 1]?.kind).toBe('note');
  });

  it('reports no window for a resolved conversation and an unknown id', () => {
    const app = harness();
    expect(windowMinutesLeft(app.state, 'cv-4808')).toBeNull();
    expect(windowMinutesLeft(app.state, 'cv-nope')).toBeNull();
  });

  it('inserts a macro or emoji into the draft', () => {
    const app = harness();
    app.run('insert', '🙏');
    expect(readDraft(app.state, 'cv-4821', 'reply')).toBe('🙏');
    app.run('insert', 'شكرًا');
    expect(readDraft(app.state, 'cv-4821', 'reply')).toBe('🙏 شكرًا');
  });

  it('records an attachment in English too', () => {
    const app = harness();
    app.run('lang', 'en');
    app.run('attach');
    expect(lastToast(app.state)).toBe('Attachment added to the draft');
    expect(JSON.stringify(app.state.timelines['cv-4821'])).toContain('nothing is uploaded');
  });

  it('records an attachment on the timeline', () => {
    const app = harness();
    const before = (app.state.timelines['cv-4821'] ?? []).length;
    app.run('attach');
    expect((app.state.timelines['cv-4821'] ?? []).length).toBe(before + 1);
    app.run('nav', 'inbox');
    const empty = harness(null);
    empty.run('attach');
    expect(empty.state.toasts).toHaveLength(0);
  });

  it('sends in English too', () => {
    const app = harness();
    app.run('lang', 'en');
    writeDraft(app.state, 'cv-4821', 'reply', 'On it');
    app.run('send');
    expect(lastToast(app.state)).toBe('Reply sent');
    app.run('composer-tab', 'note');
    writeDraft(app.state, 'cv-4821', 'note', 'internal');
    app.run('send');
    expect(lastToast(app.state)).toBe('Private note added');
    app.run('send');
    expect(lastToast(app.state)).toBe('Write something first');
  });
});

describe('assignment and claiming', () => {
  it('assigns to a colleague and records the event', () => {
    const app = harness();
    app.run('assign', 'm-tarek');
    expect(findConversation(app.state, 'cv-4821')?.assigneeId).toBe('m-tarek');
    expect(lastToast(app.state)).toContain('طارق');
  });

  it('unassigns with an empty argument', () => {
    const app = harness();
    app.run('assign', '');
    expect(findConversation(app.state, 'cv-4821')?.assigneeId).toBeNull();
    expect(findConversation(app.state, 'cv-4821')?.participantIds).toEqual([]);
  });

  it('refuses to assign others without conversation.assign', () => {
    const app = harness();
    app.state.role = 'agent';
    app.run('assign', 'm-tarek');
    expect(findConversation(app.state, 'cv-4821')?.assigneeId).toBe(CURRENT_MEMBER_ID);
    expect(app.state.toasts[0]?.tone).toBe('danger');
  });

  it('explains the missing grant in English', () => {
    const app = harness();
    app.state.role = 'agent';
    app.run('lang', 'en');
    app.run('assign', 'm-tarek');
    expect(lastToast(app.state)).toBe('Your role lacks conversation.assign');
  });

  it('names the new assignee in English', () => {
    const app = harness();
    app.run('lang', 'en');
    app.run('assign', 'm-tarek');
    expect(lastToast(app.state)).toBe('Assigned to Tarek Mounir');
  });

  it('lets an agent assign to themselves', () => {
    const app = harness();
    app.state.role = 'agent';
    app.run('assign', CURRENT_MEMBER_ID);
    expect(findConversation(app.state, 'cv-4821')?.assigneeId).toBe(CURRENT_MEMBER_ID);
  });

  it('ignores assignment with no conversation selected', () => {
    const app = harness(null);
    app.run('assign', 'm-tarek');
    expect(app.state.toasts).toHaveLength(0);
  });

  it('names an unknown member neutrally, in English too', () => {
    const app = harness();
    app.run('lang', 'en');
    app.run('assign', 'm-ghost');
    expect(lastToast(app.state)).toBe('Assigned to Unassigned');
  });

  it('claims an unassigned conversation and unlocks it', () => {
    const app = harness(null);
    app.state.role = 'agent';
    app.run('claim', 'cv-4817');
    expect(findConversation(app.state, 'cv-4817')?.assigneeId).toBe(CURRENT_MEMBER_ID);
    expect(selectedId(app.state)).toBe('cv-4817');
  });

  it('reports a version conflict when somebody claimed first', () => {
    const app = harness();
    app.run('claim', 'cv-4821');
    expect(lastToast(app.state)).toContain('CONVERSATION_VERSION_CONFLICT');
    app.run('lang', 'en');
    app.run('claim', 'cv-4821');
    expect(lastToast(app.state)).toContain('a colleague claimed it first');
  });

  it('ignores a claim on an unknown conversation', () => {
    const app = harness();
    app.run('claim', 'cv-nope');
    expect(app.state.toasts).toHaveLength(0);
  });

  it('claims in English', () => {
    const app = harness(null);
    app.run('lang', 'en');
    app.run('claim', 'cv-4817');
    expect(lastToast(app.state)).toContain('Claimed');
  });
});

describe('status, priority and unread', () => {
  it('changes status directly for open and pending', () => {
    const app = harness();
    app.run('status', 'pending');
    expect(findConversation(app.state, 'cv-4821')?.status).toBe('pending');
    app.run('status', 'open');
    expect(findConversation(app.state, 'cv-4821')?.status).toBe('open');
    app.run('lang', 'en');
    app.run('status', 'pending');
    expect(findConversation(app.state, 'cv-4821')?.status).toBe('pending');
  });

  it('opens the disposition dialog rather than resolving straight away', () => {
    const app = harness();
    app.run('status', 'resolved');
    expect(findConversation(app.state, 'cv-4821')?.status).not.toBe('resolved');
    expect(app.state.dialog?.kind).toBe('resolve');
    app.run('resolve', 'تم التسليم');
    expect(findConversation(app.state, 'cv-4821')?.status).toBe('resolved');
    expect(app.state.dialog).toBeNull();
  });

  it('ignores resolve with no dialog open, and status with no conversation', () => {
    const app = harness();
    app.run('resolve', 'x');
    expect(app.state.toasts).toHaveLength(0);
    const empty = harness(null);
    empty.run('status', 'pending');
    empty.run('priority', 'high');
    empty.run('mark-unread');
    empty.run('snooze', '60');
    expect(empty.state.toasts).toHaveLength(0);
  });

  it('resolves in English', () => {
    const app = harness();
    app.run('lang', 'en');
    app.run('status', 'resolved');
    app.run('resolve', 'Delivered');
    expect(lastToast(app.state)).toBe('Conversation resolved');
  });

  it('snoozes with a future wake time', () => {
    const app = harness();
    app.run('snooze', '180');
    const conversation = findConversation(app.state, 'cv-4821');
    expect(conversation?.status).toBe('snoozed');
    expect(new Date(conversation?.snoozedUntil ?? '').getTime()).toBeGreaterThan(NOW.getTime());
    app.run('lang', 'en');
    app.run('snooze', '60');
    expect(lastToast(app.state)).toBe('Conversation snoozed');
  });

  it('changes priority and marks unread for this user only', () => {
    const app = harness();
    app.run('priority', 'low');
    expect(findConversation(app.state, 'cv-4821')?.priority).toBe('low');
    app.run('mark-unread');
    expect(findConversation(app.state, 'cv-4821')?.unreadCount).toBe(1);
    app.run('lang', 'en');
    app.run('mark-unread');
    expect(lastToast(app.state)).toContain('Marked unread');
    app.run('priority', 'high');
    expect(lastToast(app.state)).toBe('Priority updated');
  });
});

describe('dialogs and views', () => {
  it('opens a dialog with and without an argument, and closes it', () => {
    const app = harness();
    app.run('dialog', 'filters');
    expect(app.state.dialog).toEqual({ kind: 'filters', arg: '' });
    app.run('dialog', 'member:m-tarek');
    expect(app.state.dialog).toEqual({ kind: 'member', arg: 'm-tarek' });
    app.run('close-dialog');
    expect(app.state.dialog).toBeNull();
    expect(app.state.dialogForm).toEqual({});
  });

  it('records form values and ignores malformed ones', () => {
    const app = harness();
    app.run('form', 'name:عرض جديد');
    expect(app.state.dialogForm.name).toBe('عرض جديد');
    app.run('form', 'broken');
    expect(Object.keys(app.state.dialogForm)).toEqual(['name']);
    app.run('form-toggle', 'away:on');
    expect(app.state.dialogForm.away).toBe('on');
  });

  it('refuses to save a view with no name', () => {
    const app = harness();
    app.run('dialog', 'save-view');
    app.run('save-view');
    expect(app.state.dialog?.kind).toBe('save-view');
    expect(app.state.toasts[0]?.tone).toBe('warning');
    app.run('lang', 'en');
    app.run('save-view');
    expect(lastToast(app.state)).toBe('Name the view first');
  });

  it('saves a view carrying the filters in force', () => {
    const app = harness();
    app.run('toggle-filter', 'channels:instagram');
    app.run('dialog', 'save-view');
    app.run('form', 'name:إنستجرام العاجل');
    app.run('form', 'scope:team');
    app.run('save-view');
    const saved = app.state.views[app.state.views.length - 1];
    expect(saved?.name).toBe('إنستجرام العاجل');
    expect(saved?.scope).toBe('team');
    expect(saved?.criteria.channels).toEqual(['instagram']);
    expect(app.state.activeViewId).toBe(saved?.id);
  });

  it('defaults an unknown scope to private', () => {
    const app = harness();
    app.run('dialog', 'save-view');
    app.run('form', 'name:x');
    app.run('form', 'scope:nonsense');
    app.run('save-view');
    expect(app.state.views[app.state.views.length - 1]?.scope).toBe('private');
  });

  it('deletes a view and drops it as the active one', () => {
    const app = harness();
    app.run('view', 'v-sla');
    app.run('delete-view', 'v-sla');
    expect(app.state.views.some((view) => view.id === 'v-sla')).toBe(false);
    expect(app.state.activeViewId).toBeNull();
    app.run('delete-view', 'v-vip');
    expect(app.state.activeViewId).toBeNull();
  });
});

describe('workspace actions', () => {
  it('explains every channel verb and ignores unknown ones', () => {
    const app = harness();
    for (const verb of ['test', 'reconnect', 'connect', 'disconnect']) {
      app.run('channel', `${verb}:cn-wa-1`);
      expect(app.state.toasts[app.state.toasts.length - 1]?.tone).toBe('warning');
    }
    const before = app.state.toasts.length;
    app.run('channel', 'nonsense');
    expect(app.state.toasts).toHaveLength(before);
    app.run('lang', 'en');
    app.run('channel', 'test:cn-wa-1');
    expect(lastToast(app.state)).toContain('no provider is connected');
  });

  it('rejects launching an unapproved campaign', () => {
    const app = harness();
    app.run('campaign', 'launch:cm-vip');
    expect(lastToast(app.state)).toContain('«جاهزة» لا تعني «معتمدة»');
    app.run('lang', 'en');
    app.run('campaign', 'launch:cm-vip');
    expect(lastToast(app.state)).toContain('is not “approved”');
  });

  it('rejects editing a launched campaign but allows a draft', () => {
    const app = harness();
    app.run('campaign', 'edit:cm-winter');
    expect(app.state.toasts[app.state.toasts.length - 1]?.tone).toBe('danger');
    app.run('campaign', 'edit:cm-survey');
    expect(app.state.toasts[app.state.toasts.length - 1]?.tone).toBe('warning');
    app.run('lang', 'en');
    app.run('campaign', 'edit:cm-winter');
    expect(lastToast(app.state)).toContain('Clone to a new campaign ID'.toLowerCase().slice(0, 5));
  });

  it('allows launching an approved campaign as a demo no-op', () => {
    const app = harness();
    app.run('campaign', 'launch:cm-restock');
    expect(lastToast(app.state)).toContain('إجراء تجريبي');
  });

  it('states the demo no-op in English', () => {
    const app = harness();
    app.run('lang', 'en');
    app.run('campaign', 'launch:cm-restock');
    expect(lastToast(app.state)).toContain('nothing is sent to any provider');
  });

  it('ignores an unknown campaign', () => {
    const app = harness();
    app.run('campaign', 'launch:cm-nope');
    app.run('campaign', 'nonsense');
    expect(app.state.toasts).toHaveLength(0);
  });

  it('surfaces demo actions with and without a message', () => {
    const app = harness();
    app.run('demo', 'حُفظت الإعدادات');
    expect(lastToast(app.state)).toBe('حُفظت الإعدادات');
    app.run('demo');
    expect(lastToast(app.state)).toBe('إجراء تجريبي');
    app.run('lang', 'en');
    app.run('demo');
    expect(lastToast(app.state)).toBe('Demo action');
  });
});
