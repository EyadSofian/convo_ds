/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { runAction } from '../actions';
import type { ActionContext } from '../actions';
import { toggleFilterValue } from '../filters';
import type { AppState } from '../state';
import { createState, writeDraft } from '../state';
import { buildInboxModel, defaultConversationId, renderFilterDialogBody, renderInbox } from './inbox';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function stateAt(conversationId: string | null = 'cv-4821'): AppState {
  const state = createState(NOW);
  state.route = { screen: 'inbox', conversationId, params: {} };
  return state;
}

/**
 * Both optional side zones are closed on arrival (task §3). Tests that assert
 * what is *inside* the views column or the customer panel open them first,
 * rather than the product defaulting them open to keep a test green.
 */
function openState(conversationId: string | null = 'cv-4821'): AppState {
  const state = stateAt(conversationId);
  state.viewsOpen = true;
  state.panelOpen = true;
  return state;
}

function context(state: AppState): ActionContext {
  return {
    state,
    navigate: (screen, id) => {
      state.route = { screen, conversationId: id, params: {} };
    },
    refresh: () => undefined,
  };
}

function text(element: HTMLElement): string {
  return element.textContent ?? '';
}

describe('buildInboxModel', () => {
  it('projects a filtered, sorted set with segment counts', () => {
    const model = buildInboxModel(stateAt());
    expect(model.cards.length).toBe(model.filtered.length);
    expect(model.counts.all).toBe(model.visible.length);
    expect(model.selected?.id).toBe('cv-4821');
    expect(model.denied).toBe(false);
  });

  it('forces an empty result set in the empty preview state', () => {
    const state = stateAt();
    state.preview = 'empty';
    const model = buildInboxModel(state);
    expect(model.filtered).toHaveLength(0);
    expect(model.selected).toBeNull();
  });

  it('still resolves a conversation that the current filter excludes', () => {
    const state = stateAt('cv-4808');
    state.filter = toggleFilterValue(state.filter, 'statuses', 'open');
    expect(buildInboxModel(state).selected?.id).toBe('cv-4808');
  });

  it('reports no selection for an unknown id', () => {
    expect(buildInboxModel(stateAt('cv-nope')).selected).toBeNull();
  });

  it('picks the first filtered conversation as the default', () => {
    expect(defaultConversationId(stateAt(null))).toBe('cv-4821');
    const empty = stateAt(null);
    empty.preview = 'empty';
    expect(defaultConversationId(empty)).toBeNull();
  });
});

describe('renderInbox — structure', () => {
  it('renders all five zones at desktop width', () => {
    const element = renderInbox(openState());
    expect(element.querySelector('.zone--views')).not.toBeNull();
    expect(element.querySelector('.zone--list')).not.toBeNull();
    expect(element.querySelector('.zone--thread')).not.toBeNull();
    expect(element.querySelector('.zone--panel')).not.toBeNull();
    expect(element.getAttribute('data-panel')).toBe('open');
  });

  it('drops the customer panel when it is collapsed', () => {
    const state = stateAt();
    state.panelOpen = false;
    const element = renderInbox(state);
    expect(element.querySelector('.zone--panel')).toBeNull();
    expect(element.getAttribute('data-panel')).toBe('closed');
  });

  it('groups the views column and collapses a group', () => {
    const state = openState();
    expect(renderInbox(state).querySelectorAll('.viewgroup')).toHaveLength(4);
    expect(renderInbox(state).querySelectorAll('.viewgroup__list')).toHaveLength(4);
    state.collapsedGroups = ['g-teams'];
    const collapsed = renderInbox(state);
    expect(collapsed.querySelectorAll('.viewgroup__list')).toHaveLength(3);
  });

  it('offers the five queue segments with counts', () => {
    const element = renderInbox(stateAt());
    const items = element.querySelectorAll('.segment__item');
    expect(items).toHaveLength(5);
    expect(Array.from(items).map((item) => item.getAttribute('data-arg'))).toEqual([
      'all',
      'unread',
      'read',
      'mine',
      'unassigned',
    ]);
    expect(element.querySelectorAll('.segment__count').length).toBe(5);
  });

  it('marks the active segment', () => {
    const state = stateAt();
    state.filter = { ...state.filter, queue: 'unread' };
    const pressed = Array.from(renderInbox(state).querySelectorAll('.segment__item')).filter(
      (item) => item.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.getAttribute('data-arg')).toBe('unread');
  });
});

describe('renderInbox — filters', () => {
  it('shows the filter count and active chips with a clear-all', () => {
    const state = stateAt();
    state.filter = toggleFilterValue(state.filter, 'channels', 'whatsapp');
    state.filter = { ...state.filter, query: 'شحن' };
    const element = renderInbox(state);
    expect(element.querySelector('.filterbtn__count')?.textContent).toBe('2');
    expect(element.querySelectorAll('.chip')).toHaveLength(2);
    expect(element.querySelector('.chipbar__clear')).not.toBeNull();
  });

  it('hides the chip bar when nothing is filtered', () => {
    expect(renderInbox(stateAt()).querySelector('.chipbar')).toBeNull();
  });

  it('gives each chip a removal control that maps back to its filter', () => {
    const state = stateAt();
    state.filter = toggleFilterValue(state.filter, 'statuses', 'open');
    state.filter = { ...state.filter, date: 'week', query: 'x' };
    const removes = Array.from(renderInbox(state).querySelectorAll('.chip__remove'));
    expect(removes.map((node) => node.getAttribute('data-act'))).toEqual([
      'search',
      'toggle-filter',
      'date',
    ]);
  });

  it('opens each inline filter popover', () => {
    for (const menu of ['f-assignee', 'f-status', 'f-channel', 'f-sort']) {
      const state = stateAt();
      state.openMenu = menu;
      expect(renderInbox(state).querySelectorAll('.popover').length).toBeGreaterThan(0);
    }
  });

  it('marks an inline filter button active when it holds a value', () => {
    const state = stateAt();
    state.filter = toggleFilterValue(state.filter, 'assignees', 'm-tarek');
    const buttonEl = renderInbox(state).querySelector('[data-arg="f-assignee"]');
    expect(buttonEl?.getAttribute('data-active')).toBe('true');
  });

  it('renders the advanced filter dialog body with every attribute group', () => {
    const state = stateAt();
    const groups = renderFilterDialogBody(state);
    expect(groups.length).toBe(7);
    const markup = groups.map((group) => group.outerHTML).join('');
    expect(markup).toContain('inboxes:ib-ig');
    expect(markup).toContain('teams:t-care');
    expect(markup).toContain('priorities:urgent');
    expect(markup).toContain('labels:lb-vip');
    expect(markup).toContain('slas:breached');
    expect(markup).toContain('data-act="date"');
    expect(markup).toContain('statuses:resolved');
  });

  it('reflects selected values in the advanced dialog', () => {
    const state = stateAt();
    state.filter = toggleFilterValue(state.filter, 'priorities', 'urgent');
    state.filter = { ...state.filter, date: 'today' };
    const markup = renderFilterDialogBody(state).map((group) => group.outerHTML).join('');
    expect(markup).toContain('aria-pressed="true"');
    expect(renderFilterDialogBody({ ...state, lang: 'en' }).length).toBe(7);
  });
});

describe('renderInbox — conversation rows', () => {
  it('renders an unread row with a marker, count, assignee and time', () => {
    const element = renderInbox(stateAt());
    const row = element.querySelector('.convrow--unread');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-unread="true"]')).not.toBeNull();
    expect(row?.querySelector('.count--accent')).not.toBeNull();
    expect(row?.querySelector('.convrow__assignee')).not.toBeNull();
    expect(row?.querySelector('.convrow__time')?.textContent?.length).toBeGreaterThan(0);
    expect(row?.querySelector('.avatar__channel')).not.toBeNull();
  });

  it('flags unassigned rows and suppresses the status pill when open', () => {
    const state = stateAt();
    state.filter = { ...state.filter, queue: 'unassigned' };
    const rows = renderInbox(state).querySelectorAll('.convrow');
    expect(rows.length).toBeGreaterThan(0);
    expect(text(rows[0] as HTMLElement)).toContain('غير مُسندة');
    expect(text(rows[0] as HTMLElement)).not.toContain('مفتوحة');
  });

  it('shows a status pill for non-open conversations', () => {
    const state = stateAt();
    state.filter = toggleFilterValue(state.filter, 'statuses', 'resolved');
    const row = renderInbox(state).querySelector('.convrow');
    expect(text(row as HTMLElement)).toContain('محلولة');
  });

  it('shows the outgoing direction marker on an agent-authored preview', () => {
    const state = stateAt();
    state.filter = toggleFilterValue(state.filter, 'inboxes', 'ib-mg');
    expect(renderInbox(state).querySelector('.convrow__dir--out')).not.toBeNull();
  });

  it('marks the selected row', () => {
    const current = renderInbox(stateAt('cv-4820')).querySelector('[aria-current="true"].convrow');
    expect(current?.getAttribute('data-arg')).toBe('cv-4820');
  });
});

describe('renderInbox — queue privacy', () => {
  it('never renders a transcript snippet on an unassigned preview', () => {
    const state = stateAt(null);
    state.role = 'agent';
    state.filter = { ...state.filter, queue: 'unassigned' };
    const element = renderInbox(state);
    const rows = element.querySelectorAll('.convrow');
    expect(rows.length).toBeGreaterThan(0);
    const markup = element.innerHTML;
    for (const conversation of state.conversations.filter((entry) => entry.assigneeId === null)) {
      expect(markup).not.toContain(conversation.snippet);
    }
    expect(text(element)).toContain('المحتوى محجوب حتى الاستلام');
    expect(element.querySelector('[data-act="claim"]')).not.toBeNull();
  });

  it('never renders a queue contact’s name, phone or labels', () => {
    const state = stateAt(null);
    state.role = 'agent';
    state.filter = { ...state.filter, queue: 'unassigned' };
    const markup = renderInbox(state).innerHTML;
    for (const contact of state.dataset.contacts) {
      expect(markup).not.toContain(contact.name);
      if (contact.phone !== null) expect(markup).not.toContain(contact.phone);
    }
  });

  it('shows a claim-first thread and a locked customer panel for a queue card', () => {
    const state = openState('cv-4817');
    state.role = 'agent';
    const element = renderInbox(state);
    expect(text(element)).toContain('بطاقة طابور');
    expect(element.querySelector('[data-act="claim"][data-arg="cv-4817"]')).not.toBeNull();
    expect(text(element)).toContain('بطاقة الطابور لا تحمل اسمًا');
    expect(element.querySelector('.composer')).toBeNull();
  });

  it('unlocks the full timeline after a claim', () => {
    const state = stateAt('cv-4817');
    state.role = 'agent';
    runAction('claim', context(state), 'cv-4817');
    const element = renderInbox(state);
    expect(element.querySelector('.composer')).not.toBeNull();
    expect(text(element)).toContain('أحمد بدر الدين');
  });

  it('hides an unassigned card that is no longer claimable', () => {
    const state = stateAt('cv-4817');
    state.role = 'agent';
    state.conversations = state.conversations.map((entry) =>
      entry.id === 'cv-4817' ? { ...entry, assigneeId: 'm-tarek', participantIds: ['m-tarek'] } : entry,
    );
    expect(text(renderInbox(state))).toContain('غير متاحة');
  });
});

describe('renderInbox — thread and composer', () => {
  it('renders the timeline with day separators, notes and events', () => {
    const element = renderInbox(stateAt());
    expect(element.querySelectorAll('.daysep').length).toBeGreaterThan(0);
    expect(element.querySelector('.msg--note')).not.toBeNull();
    expect(element.querySelector('.msg--event')).not.toBeNull();
    expect(element.querySelector('.msg--out')).not.toBeNull();
    expect(element.querySelector('.msg__attachment')).not.toBeNull();
  });

  it('offers reply and note tabs and switches the styled area', () => {
    const state = stateAt();
    const reply = renderInbox(state);
    expect(reply.querySelector('.composer__area')?.getAttribute('data-tab')).toBe('reply');
    state.composerTab = 'note';
    const note = renderInbox(state);
    expect(note.querySelector('.composer__area')?.getAttribute('data-tab')).toBe('note');
    expect(text(note)).toContain('لا يُنشأ أمر إرسال للملاحظات');
  });

  it('carries the draft into the textarea', () => {
    const state = stateAt();
    writeDraft(state, 'cv-4821', 'reply', 'مسودة محفوظة');
    expect(renderInbox(state).querySelector('.composer__input')?.textContent).toBe('مسودة محفوظة');
  });

  it('blocks a free-form reply when the channel window has closed', () => {
    const state = stateAt('cv-4809');
    const element = renderInbox(state);
    expect(element.querySelector('.composer__blocked')).not.toBeNull();
    expect(text(element)).toContain('انتهت نافذة الـ 24 ساعة');
    state.composerTab = 'note';
    expect(renderInbox(state).querySelector('.composer__blocked')).toBeNull();
  });

  it('reports no active window on a resolved conversation', () => {
    const state = stateAt('cv-4808');
    expect(text(renderInbox(state))).toContain('لا نافذة نشطة');
  });

  it('offers assignment, status, snooze, priority, resolve and more menus', () => {
    const state = stateAt();
    const element = renderInbox(state);
    for (const menu of ['th-assign', 'th-status', 'th-priority', 'th-more']) {
      expect(element.querySelector(`[data-arg="${menu}"]`)).not.toBeNull();
    }
    expect(element.querySelector('[data-act="status"][data-arg="resolved"]')).not.toBeNull();
    expect(element.querySelector('[data-act="dialog"][data-arg="snooze"]')).not.toBeNull();
  });

  it('opens each thread menu', () => {
    for (const menu of ['th-assign', 'th-status', 'th-priority', 'th-more', 'c-macro', 'c-emoji']) {
      const state = stateAt();
      state.openMenu = menu;
      expect(renderInbox(state).querySelectorAll('.popover').length).toBeGreaterThan(0);
    }
  });

  it('titles the assignment menu differently without conversation.assign', () => {
    const state = stateAt();
    state.role = 'agent';
    state.openMenu = 'th-assign';
    expect(text(renderInbox(state))).toContain('إسناد (لك فقط)');
  });

  it('shows the outcome-unknown delivery state in its own colour', () => {
    const state = stateAt();
    state.timelines = {
      ...state.timelines,
      'cv-4821': [
        {
          kind: 'message',
          id: 'm-unknown',
          direction: 'out',
          authorName: 'هناء',
          body: 'x',
          at: NOW.toISOString(),
          delivery: 'unknown',
        },
      ],
    };
    const element = renderInbox(state);
    expect(element.querySelector('.pill--unknown')).not.toBeNull();
    expect(text(element)).toContain('نتيجة غير معروفة');
  });
});

describe('renderInbox — customer panel', () => {
  it('shows allowlisted identity, labels, consent, attributes, CRM and history', () => {
    const element = renderInbox(openState());
    const panel = element.querySelector('.zone--panel') as HTMLElement;
    expect(text(panel)).toContain('مريم خالد عبد الجواد');
    expect(text(panel)).toContain('+20 100 234 8190');
    expect(text(panel)).toContain('حقول مسموح بها فقط');
    expect(text(panel)).toContain('الموافقة والحجب');
    expect(text(panel)).toContain('Odoo');
    expect(panel.querySelectorAll('.history__item').length).toBeGreaterThan(0);
  });

  it('renders missing identity fields honestly and an empty history', () => {
    const panel = renderInbox(openState('cv-4814')).querySelector('.zone--panel') as HTMLElement;
    expect(text(panel)).toContain('غير متاح');
    expect(text(panel)).toContain('لا محادثات سابقة');
    expect(text(panel)).toContain('غير مرتبط بأي نظام خارجي');
    expect(text(panel)).toContain('لا وسوم');
  });

  it('shows an active suppression and a withdrawn consent', () => {
    const panel = renderInbox(openState('cv-4809')).querySelector('.zone--panel') as HTMLElement;
    expect(text(panel)).toContain('مسحوبة');
    expect(text(panel)).toContain('نشط');
    expect(panel.querySelector('.pill--danger')).not.toBeNull();
  });

  it('handles a conversation whose contact record has gone', () => {
    const state = openState();
    state.dataset = { ...state.dataset, contacts: [] };
    expect(text(renderInbox(state))).toContain('لا يوجد سجل عميل');
  });

  it('handles a contact with no consent record', () => {
    const state = openState();
    state.dataset = {
      ...state.dataset,
      contacts: state.dataset.contacts.map((contact) => ({ ...contact, consent: [] })),
    };
    expect(text(renderInbox(state))).toContain('غير مسجّلة');
  });
});

describe('renderInbox — customer panel without a conversation', () => {
  it('shows an honest empty panel when nothing is selected', () => {
    const state = openState(null);
    const element = renderInbox(state);
    const panel = element.querySelector('.zone--panel');
    expect(panel).not.toBeNull();
    expect(text(panel as HTMLElement)).toContain('لا يوجد عميل معروض');
  });

  it('records a consent state that is neither granted nor withdrawn', () => {
    // `none` is a real third state: an identity we hold with no consent
    // decision on file. It must not read as a grant (business-rules §6).
    const state = openState();
    const conversation = state.conversations.find((entry) => entry.id === 'cv-4821');
    const contact = state.dataset.contacts.find((entry) => entry.id === conversation?.contactId);
    if (contact === undefined || conversation === undefined) throw new Error('seed changed');
    const patched = {
      ...contact,
      consent: [{ ...(contact.consent[0] as (typeof contact.consent)[number]), state: 'none' as const }],
    };
    state.dataset = {
      ...state.dataset,
      contacts: state.dataset.contacts.map((entry) => (entry.id === contact.id ? patched : entry)),
    };
    const panel = renderInbox(state).querySelector('.zone--panel');
    expect(text(panel as HTMLElement)).toContain('غير مسجّلة');
  });
});

describe('renderInbox — drawer state and missing identity fields', () => {
  it('marks the list drawer open and renders its dismiss surface', () => {
    const state = openState();
    state.listOpen = true;
    const element = renderInbox(state);
    expect(element.getAttribute('data-list')).toBe('open');
    expect(element.querySelector('.zone-scrim--list')).not.toBeNull();
  });

  it('says a missing phone, email or handle is not available rather than blank', () => {
    const state = openState();
    const conversation = state.conversations.find((entry) => entry.id === 'cv-4821');
    const contact = state.dataset.contacts.find((entry) => entry.id === conversation?.contactId);
    if (contact === undefined) throw new Error('seed changed');
    const stripped = { ...contact, phone: null, email: null, handle: null };
    state.dataset = {
      ...state.dataset,
      contacts: state.dataset.contacts.map((entry) => (entry.id === contact.id ? stripped : entry)),
    };
    const panel = renderInbox(state).querySelector('.zone--panel');
    const grid = (panel as HTMLElement).querySelector('.attrgrid');
    // Three allowlisted identity fields, all absent, all stated honestly.
    expect(text(grid as HTMLElement).match(/غير متاح/g)).toHaveLength(3);
  });

  it('shows each identity field the contact actually carries', () => {
    const state = openState();
    const panel = renderInbox(state).querySelector('.zone--panel');
    const grid = text((panel as HTMLElement).querySelector('.attrgrid') as HTMLElement);
    // The seeded WhatsApp contact has a phone and an email but no handle, so
    // exactly one field reports itself missing.
    expect(grid).toContain('+20 100 234 8190');
    expect(grid).toContain('mariam.kh');
    expect(grid.match(/غير متاح/g)).toHaveLength(1);
  });

  it('shows a social handle when the channel identity has one', () => {
    // An Instagram contact is reached by handle rather than by phone, so the
    // same panel has to render the opposite combination.
    const state = openState('cv-4818');
    const panel = renderInbox(state).querySelector('.zone--panel');
    const grid = text((panel as HTMLElement).querySelector('.attrgrid') as HTMLElement);
    expect(grid).toContain('@rana.style');
  });
});

describe('renderInbox — preview states', () => {
  it('renders skeletons while loading', () => {
    const state = stateAt();
    state.preview = 'loading';
    const element = renderInbox(state);
    expect(element.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(element.querySelectorAll('.skeleton').length).toBeGreaterThan(4);
  });

  it('renders an empty list and an empty thread', () => {
    const state = stateAt();
    state.preview = 'empty';
    const element = renderInbox(state);
    expect(text(element)).toContain('لا توجد محادثات مطابقة');
    expect(text(element)).toContain('لم تُختر محادثة');
    expect(element.querySelector('[data-act="clear-filters"]')).not.toBeNull();
  });

  it('renders a stale banner and disables sending when offline', () => {
    const state = stateAt();
    state.preview = 'offline';
    const element = renderInbox(state);
    expect(element.querySelector('.banner--warning')).not.toBeNull();
    expect(element.querySelector('.composer__input')).toBeNull();
    expect(text(element)).toContain('الإرسال معطّل بلا اتصال');
    expect(element.querySelector('[data-act="preview"][data-arg="ready"]')).not.toBeNull();
  });

  it('renders permission-denied for the thread and the panel', () => {
    const state = openState();
    state.preview = 'denied';
    const element = renderInbox(state);
    expect(element.querySelectorAll('.statebox--denied')).toHaveLength(2);
    expect(text(element)).toContain('conversation.read');
    expect(text(element)).toContain('contact.read');
  });

  it('denies the whole inbox to a role with no conversation grant', () => {
    const state = stateAt();
    state.role = 'campaign_manager';
    const element = renderInbox(state);
    expect(element.querySelector('.inbox')).toBeNull();
    expect(text(element)).toContain('صندوق الوارد غير متاح لدورك');
    expect(element.querySelector('[data-act="role"][data-arg="supervisor"]')).not.toBeNull();
  });
});

describe('renderInbox — English', () => {
  it('renders the whole screen in English', () => {
    const state = openState();
    state.lang = 'en';
    const element = renderInbox(state);
    expect(text(element)).toContain('Conversations');
    expect(text(element)).toContain('Saved views');
    expect(text(element)).toContain('Public reply');
    expect(text(element)).toContain('Consent & suppression');
  });

  it('names saved-view scopes in English', () => {
    const state = openState();
    state.lang = 'en';
    const scopes = Array.from(renderInbox(state).querySelectorAll('.viewitem__scope')).map(
      (node) => node.textContent,
    );
    expect(scopes).toContain('Private');
    expect(scopes).toContain('Team');
    expect(scopes).toContain('Workspace');
  });

  it('falls back to raw ids for unknown members, inboxes and teams', () => {
    const state = stateAt();
    // Tenant scope, so a dangling inbox reference still resolves to a row
    // instead of being denied for being outside the actor's inboxes.
    state.role = 'admin';
    state.conversations = state.conversations.map((entry) =>
      entry.id === 'cv-4821'
        ? { ...entry, assigneeId: 'm-ghost', inboxId: 'ib-ghost', teamId: 't-ghost' }
        : entry,
    );
    const markup = renderInbox(state).innerHTML;
    expect(markup).toContain('m-ghost');
    expect(markup).toContain('ib-ghost');
    expect(markup).toContain('t-ghost');
  });
});
