import type { QuickReply } from '../api/metadata.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { hasPermission } from '../live/ability.js';
import { matchQuickReplies, quickReplyText } from '../live/quick-replies.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { button } from './parts.js';

export const QUICK_REPLY_MENU = 'quick-replies';

/**
 * The composer's quick reply button and its list.
 *
 * Location replies come first, with a pin, because "where are you?" is the
 * one a customer usually asks while waiting. A pick goes in at the caret, as
 * an emoji does, and the agent can still edit it before sending.
 */
export function quickReplyPicker(state: AppState): HTMLElement {
  const opened = state.openMenu === QUICK_REPLY_MENU;
  return h('div', { class: 'composer__emoji composer__quick' }, [
    button({
      icon: 'macro',
      act: 'menu',
      arg: QUICK_REPLY_MENU,
      variant: 'ghost',
      small: true,
      expanded: opened,
      haspopup: 'dialog',
      title: t(state, 'الردود السريعة — أو اكتب / في الرسالة', 'Quick replies — or type / in the message'),
      ariaLabel: t(state, 'الردود السريعة', 'Quick replies'),
      extraClass: opened ? 'composer__tool btn--active' : 'composer__tool',
    }),
    opened ? quickReplyPanel(state) : null,
  ]);
}

function quickReplyPanel(state: AppState): HTMLElement {
  const resource = state.live.quickReplies;
  const replies = [...rowsOf(resource)].sort((left, right) => Number(right.kind === 'location') - Number(left.kind === 'location'));
  const body: Child = resource.status === 'idle' || resource.status === 'loading'
    ? h('p', { class: 'quick-replies__empty', role: 'status' }, [t(state, 'جارٍ تحميل الردود…', 'Loading replies…')])
    : resource.status === 'error'
      ? h('div', { class: 'quick-replies__empty', role: 'alert' }, [
          h('p', {}, [t(state, 'تعذّر تحميل الردود السريعة.', 'Quick replies could not be loaded.')]),
          button({ label: t(state, 'إعادة المحاولة', 'Try again'), act: 'live-quick-replies-reload', small: true, variant: 'ghost' }),
        ])
      : replies.length === 0
        ? h('p', { class: 'quick-replies__empty' }, [hasPermission(state.live, 'catalog.manage')
          ? t(state, 'لا توجد ردود سريعة بعد. أضفها من الإعدادات.', 'No quick replies yet. Add them in Settings.')
          : t(state, 'لا توجد ردود سريعة بعد. اطلب من المسؤول إضافتها.', 'No quick replies yet. Ask an admin to add some.')])
        : h('ul', { class: 'quick-replies__list', role: 'list' }, replies.map((reply) => h('li', {}, [quickReplyItem(state, reply, false)])));
  return h('div', { class: 'popover quick-replies', role: 'dialog', 'data-overlay': 'popover', 'aria-label': t(state, 'الردود السريعة', 'Quick replies') }, [
    h('p', { class: 'quick-replies__heading' }, [t(state, 'الردود السريعة', 'Quick replies'), h('span', { class: 'quick-replies__tip' }, [t(state, 'اكتب / للبحث', 'Type / to search')])]),
    body,
  ]);
}

/**
 * The suggestions under a "/shortcut" being typed. The highlighted one is what
 * Enter or Tab uses; the list is a listbox the reply box points at, so a
 * screen reader announces the highlighted reply as it moves.
 */
export function slashSuggestions(state: AppState): HTMLElement | null {
  const live = state.live;
  if (live.slash === null) return null;
  const matches = matchQuickReplies(rowsOf(live.quickReplies), live.slash.query);
  if (live.quickReplies.status !== 'ready') {
    return h('div', { class: 'slash-list', role: 'status' }, [h('p', { class: 'quick-replies__empty' }, [t(state, 'جارٍ تحميل الردود…', 'Loading replies…')])]);
  }
  if (matches.length === 0) {
    return h('div', { class: 'slash-list', role: 'status' }, [h('p', { class: 'quick-replies__empty' }, [
      live.slash.query === ''
        ? t(state, 'لا توجد ردود سريعة بعد.', 'No quick replies yet.')
        : t(state, `لا يوجد رد يطابق «/${live.slash.query}»`, `No reply matches “/${live.slash.query}”`),
    ])]);
  }
  const active = Math.min(live.slashActive, matches.length - 1);
  return h('div', { class: 'slash-list' }, [
    h('ul', { class: 'quick-replies__list', role: 'listbox', id: 'slash-list', 'aria-label': t(state, 'اقتراحات الردود السريعة', 'Quick reply suggestions') },
      matches.map((reply, index) => h('li', { role: 'presentation' }, [quickReplyItem(state, reply, index === active)]))),
    h('p', { class: 'slash-list__hint' }, [t(state, '↑↓ للتنقل · Enter للإدراج · Esc للإغلاق', '↑↓ to move · Enter to insert · Esc to close')]),
  ]);
}

function quickReplyItem(state: AppState, reply: QuickReply, active: boolean): HTMLElement {
  const preview = quickReplyText(reply).replace(/\s+/g, ' ');
  return h('button', {
    type: 'button',
    class: active ? 'quick-reply quick-reply--active' : 'quick-reply',
    id: active ? 'slash-active' : undefined,
    role: state.live.slash === null ? undefined : 'option',
    'aria-selected': state.live.slash === null ? undefined : String(active),
    'data-act': 'live-quick-reply-pick',
    'data-arg': reply.id,
  }, [
    h('span', { class: 'quick-reply__head' }, [
      reply.kind === 'location' ? icon('pin', 14) : null,
      h('span', { class: 'quick-reply__shortcut', dir: 'auto' }, [`/${reply.shortcut}`]),
      h('span', { class: 'quick-reply__title', dir: 'auto' }, [reply.title]),
    ]),
    h('span', { class: 'quick-reply__preview', dir: 'auto' }, [preview.length > 90 ? `${preview.slice(0, 90)}…` : preview]),
  ]);
}
