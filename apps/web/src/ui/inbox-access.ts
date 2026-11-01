import type { ScopeRef } from '../api/people.js';
import { h } from '../dom.js';
import { openSession, rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { button, inlineError, notice, selectControl } from './parts.js';

export function accessMode(state: AppState, prefix: string, initial: readonly ScopeRef[]): string {
  return state.dialogForm[`${prefix}Mode`] ?? (initial.some((s) => s.type === 'tenant') ? 'tenant'
    : initial.some((s) => s.type !== 'inbox') ? 'existing' : initial.length > 0 ? 'selected' : 'none');
}

export function selectedInboxIds(state: AppState, prefix: string, initial: readonly ScopeRef[]): string[] {
  const ids = new Set(initial.flatMap((s) => s.type === 'inbox' && s.id !== null ? [s.id] : []));
  for (const [key, value] of Object.entries(state.dialogForm)) {
    if (!key.startsWith(`${prefix}Inbox_`)) continue;
    const id = key.slice(`${prefix}Inbox_`.length);
    if (value === 'true') ids.add(id); else ids.delete(id);
  }
  return [...ids];
}

export function inboxAccessFields(state: AppState, prefix: string, initial: readonly ScopeRef[] = []): HTMLElement {
  const mode = accessMode(state, prefix, initial);
  const actor = rowsOf(state.live.people).find((p) => p.email === openSession(state.live).email);
  const tenantWide = actor?.scopes.some((s) => s.type === 'tenant') === true;
  const selected = new Set(selectedInboxIds(state, prefix, initial));
  const inboxes = rowsOf(state.live.memberInboxes);
  const missing = [...selected].filter((id) => !inboxes.some((i) => i.id === id));
  return h('fieldset', { class: 'field member-inbox-access', 'aria-label': t(state, 'الوصول إلى الإنبوكسات', 'Inbox access') }, [
    h('legend', { class: 'field__label' }, [t(state, 'الوصول إلى الإنبوكسات', 'Inbox access')]),
    selectControl({ ariaLabel: t(state, 'نطاق الوصول إلى الإنبوكسات', 'Inbox access scope'), id: `${prefix}-mode`, form: `${prefix}Mode`, act: 'form-toggle', value: mode, options: [
      { value: 'none', label: t(state, 'بلا وصول إلى الإنبوكسات', 'No inbox access') },
      { value: 'selected', label: t(state, 'إنبوكسات محددة فقط', 'Selected inboxes only') },
      ...(tenantWide || mode === 'tenant' ? [{ value: 'tenant', label: t(state, 'كل الإنبوكسات الحالية والجديدة', 'All current and future inboxes') }] : []),
      ...(initial.some((s) => s.type !== 'inbox' && s.type !== 'tenant') ? [{ value: 'existing', label: t(state, 'الاحتفاظ بنطاق الفرق الحالي', 'Keep current team scope') }] : []),
    ] }),
    mode === 'selected' ? h('div', {}, [
      state.live.memberInboxes.status === 'error' ? inlineError(state, state.live.memberInboxes.error) : null,
      state.live.memberInboxes.status === 'loading' || state.live.memberInboxes.status === 'idle'
        ? h('p', { role: 'status' }, [t(state, 'جارٍ تحميل الإنبوكسات…', 'Loading inboxes…')]) : null,
      h('ul', { class: 'pick-list' }, inboxes.map((inbox) => h('li', { class: 'pick-list__item' }, [
        h('div', { class: 'pick-list__name member-inbox-access__name' }, [inbox.display_name,
          h('span', { class: 'table__sub', dir: 'ltr' }, [`${inbox.kind} · ${inbox.external_asset_id}`])]),
        button({ label: selected.has(inbox.id) ? t(state, 'مسموح', 'Allowed') : t(state, 'السماح', 'Allow'),
          ariaLabel: `${t(state, 'السماح بالوصول إلى', 'Allow access to')} ${inbox.display_name}`,
          act: 'form-toggle', arg: `${prefix}Inbox_${inbox.id}:${selected.has(inbox.id) ? 'false' : 'true'}`,
          pressed: selected.has(inbox.id), small: true, variant: selected.has(inbox.id) ? 'primary' : 'default' }),
      ]))),
      state.live.memberInboxes.status === 'ready' && inboxes.length === 0
        ? h('p', {}, [t(state, 'لا توجد إنبوكسات يمكنك منحها.', 'No inboxes available to grant.')]) : null,
      missing.length > 0 ? h('p', { class: 'field__hint' }, [t(state, 'يوجد نطاق سابق غير متاح؛ لن يُحذف دون اختيارك.', 'An existing inbox is unavailable; remove it explicitly to revoke access.'),
        ...missing.map((id) => button({ label: `${t(state, 'إزالة', 'Remove')} ${id}`, act: 'form-toggle', arg: `${prefix}Inbox_${id}:false`, small: true }))]) : null,
    ]) : null,
    h('p', { class: 'field__hint' }, [t(state,
      'اختيار إنبوكسات محددة يستبدل نطاق مساحة العمل والفرق. عضوية الفريق تبقى كما هي، وصلاحيات الدور تحدد قراءة المحادثات والرد عليها.',
      'Selected inboxes replace workspace and team access scopes. Team membership stays the same; the role controls reading and replying.')]),
    notice('plain', 'shield', t(state, 'الأدمن والمالك يريان كل الإنبوكسات بصلاحيات دورهما. لتقييد مستخدم اختر دور موظف أو مشرف بنطاق محدود.',
      'Admins and Owners have workspace-wide role permissions. Use an Agent or scoped Supervisor role to restrict inbox access.')),
    state.formErrors[`${prefix}Access`] === undefined ? null : h('p', { class: 'field__error', role: 'alert' }, [state.formErrors[`${prefix}Access`]]),
  ]);
}

/** Returns null for a selection that must not be submitted. The API still enforces delegation. */
export function readInboxAccess(state: AppState, prefix: string, initial: readonly ScopeRef[], roleId: string): readonly ScopeRef[] | null {
  const mode = accessMode(state, prefix, initial);
  if (mode === 'existing') return initial;
  if (mode === 'tenant') return [{ type: 'tenant', id: null }];
  const role = rowsOf(state.live.roles).find((r) => r.id === roleId);
  if (role?.key === 'admin' || role?.key === 'owner' || role?.grants.some((g) => g.permission_key === 'conversation.read' && g.scope_level === 'tenant')) return null;
  if (mode !== 'selected') return [];
  const ids = selectedInboxIds(state, prefix, initial);
  if (state.live.memberInboxes.status !== 'ready' || ids.length === 0) return null;
  return ids.map((id) => ({ type: 'inbox', id }));
}
