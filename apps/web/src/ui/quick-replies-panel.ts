import type { QuickReply } from '../api/metadata.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { mapsUrl, quickReplyText } from '../live/quick-replies.js';
import type { QUICK_REPLY_FORM } from '../live/quick-reply-actions.js';
import { quickReplyInputFrom } from '../live/quick-reply-actions.js';
import { rowsOf } from '../live/store.js';
import type { AppState } from '../state.js';
import { t } from './copy.js';
import { button, dialogShell, emptyState, errorState, field, inlineError, notice, panel, skeleton, textInput } from './parts.js';

/** Settings › Quick replies: the saved answers agents insert with a button or "/shortcut". */
export function quickRepliesPanel(state: AppState): HTMLElement {
  const resource = state.live.quickReplies;
  const replies = rowsOf(resource);
  const body = resource.status === 'idle' || resource.status === 'loading'
    ? skeleton(state, 2)
    : resource.status === 'error'
      ? errorState(state, resource.error, 'live-quick-replies-reload')
      : replies.length === 0
        ? emptyState({ icon: 'macro', title: t(state, 'لا توجد ردود سريعة', 'No quick replies'), body: t(state, 'احفظ الإجابات المتكررة — الأسعار، المواعيد، العنوان — ليرسلها فريقك بنقرة أو بكتابة /.', 'Save the answers you repeat — prices, hours, your address — so the team sends them with a click or by typing /.') })
        : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', { scope: 'col' }, [t(state, 'الاختصار', 'Shortcut')]),
              h('th', { scope: 'col' }, [t(state, 'العنوان', 'Title')]),
              h('th', { scope: 'col' }, [t(state, 'المحتوى', 'Content')]),
              h('th', { scope: 'col' }, [t(state, 'إجراءات', 'Actions')]),
            ])]),
            h('tbody', {}, replies.map((reply) => h('tr', {}, [
              h('td', {}, [h('code', { class: 'quick-reply__shortcut', dir: 'auto' }, [`/${reply.shortcut}`])]),
              h('td', { dir: 'auto' }, [reply.kind === 'location' ? icon('pin', 14) : null, ' ', reply.title]),
              h('td', { class: 'quick-reply__cell', dir: 'auto' }, [quickReplyText(reply)]),
              h('td', {}, [h('div', { class: 'button-row' }, [
                button({ label: t(state, 'تعديل', 'Edit'), act: 'dialog', arg: `quick-reply:${reply.id}`, small: true, variant: 'ghost' }),
                button({ label: t(state, 'حذف', 'Delete'), act: 'dialog', arg: `quick-reply-delete:${reply.id}`, small: true, variant: 'danger' }),
              ])]),
            ]))),
          ])]);
  return panel(t(state, 'الردود السريعة', 'Quick replies'), [body], {
    actions: [
      button({ label: t(state, 'موقع جديد', 'New location'), icon: 'pin', act: 'dialog', arg: 'quick-reply-location', small: true, variant: 'ghost' }),
      button({ label: t(state, 'رد سريع جديد', 'New quick reply'), icon: 'plus', act: 'dialog', arg: 'quick-reply', small: true, variant: 'primary' }),
    ],
    description: t(state, 'في المحادثة: زر الردود السريعة، أو اكتب / ثم الاختصار.', 'In a conversation: the quick reply button, or type / and the shortcut.'),
  });
}

/** Add or edit one reply. A location carries a place; a text reply carries its message. */
export function quickReplyDialog(state: AppState, arg: string, presetKind: 'text' | 'location'): HTMLElement {
  const existing = rowsOf(state.live.quickReplies).find((reply) => reply.id === arg);
  const form = state.dialogForm;
  const draft = quickReplyInputFrom({ quickReplyKind: existing?.kind ?? presetKind, ...form }, existing);
  const location = draft.kind === 'location';
  const value = (key: (typeof QUICK_REPLY_FORM)[number], fallback: string): string => form[key] ?? fallback;
  const busy = state.live.busy === (existing === undefined ? 'quick-reply:create' : `quick-reply:update:${existing.id}`);
  const kindButton = (kind: 'text' | 'location', label: string): HTMLElement => h('button', {
    type: 'button', class: draft.kind === kind ? 'btn btn--sm btn--active' : 'btn btn--sm btn--ghost',
    'aria-pressed': String(draft.kind === kind), 'data-act': 'form-toggle', 'data-arg': `quickReplyKind:${kind}`,
  }, [icon(kind === 'location' ? 'pin' : 'chat', 14), label]);
  const place = existing?.location;
  const preview = location && draft.location !== null && Number.isFinite(draft.location.latitude) && Number.isFinite(draft.location.longitude)
    ? mapsUrl(draft.location)
    : null;
  const title = existing === undefined
    ? location ? t(state, 'موقع جديد', 'New location') : t(state, 'رد سريع جديد', 'New quick reply')
    : t(state, 'تعديل الرد السريع', 'Edit quick reply');
  return dialogShell(state, title, [
    inlineError(state, state.live.error),
    h('form', { class: 'form-grid', 'data-submit': 'live-quick-reply-save', novalidate: true }, [
      h('div', { class: 'button-row field--wide', role: 'group', 'aria-label': t(state, 'نوع الرد', 'Reply type') }, [
        kindButton('text', t(state, 'نص', 'Text')),
        kindButton('location', t(state, 'موقع', 'Location')),
      ]),
      field(t(state, 'الاختصار', 'Shortcut'), textInput('quickReplyShortcut', value('quickReplyShortcut', existing?.shortcut ?? ''), location ? 'branch' : 'prices', { required: true }),
        t(state, 'كلمة واحدة بلا مسافات. في المحادثة اكتب / ثم الاختصار.', 'One word, no spaces. In a conversation, type / and the shortcut.')),
      field(t(state, 'العنوان', 'Title'), textInput('quickReplyTitle', value('quickReplyTitle', existing?.title ?? ''), location ? t(state, 'عنوان الفرع', 'Branch address') : t(state, 'قائمة الأسعار', 'Price list'), { required: true })),
      location ? field(t(state, 'اسم المكان', 'Place name'), textInput('quickReplyPlace', value('quickReplyPlace', place?.name ?? ''), t(state, 'فرع مدينة نصر', 'Nasr City branch'), { required: true })) : null,
      location ? field(t(state, 'العنوان التفصيلي', 'Street address'), textInput('quickReplyAddress', value('quickReplyAddress', place?.address ?? ''), t(state, 'اختياري', 'Optional'))) : null,
      location ? field(t(state, 'خط العرض', 'Latitude'), textInput('quickReplyLatitude', value('quickReplyLatitude', place === undefined || place === null ? '' : String(place.latitude)), '30.0444', { inputmode: 'decimal', required: true })) : null,
      location ? field(t(state, 'خط الطول', 'Longitude'), textInput('quickReplyLongitude', value('quickReplyLongitude', place === undefined || place === null ? '' : String(place.longitude)), '31.2357', { inputmode: 'decimal', required: true })) : null,
      location ? h('p', { class: 'field__hint field--wide' }, [t(state, 'من خرائط جوجل: اضغط مطولًا على المكان وانسخ الرقمين الظاهرين.', 'From Google Maps: long-press the place and copy the two numbers shown.')]) : null,
      h('div', { class: 'field--wide' }, [field(location ? t(state, 'ملاحظة مع الموقع', 'Note with the location') : t(state, 'نص الرد', 'Reply text'),
        h('textarea', { class: 'textarea', rows: '4', dir: 'auto', maxlength: '4000', 'data-act': 'form', 'data-form': 'quickReplyBody', 'aria-label': t(state, 'نص الرد', 'Reply text'),
          placeholder: location ? t(state, 'اختياري — مثل مواعيد العمل', 'Optional — such as opening hours') : t(state, 'أهلاً بيك! أسعار الكورسات…', 'Hello! Our course prices…') }, [value('quickReplyBody', existing?.body ?? '')]))]),
      preview === null ? null : h('a', { class: 'link field--wide', href: preview, target: '_blank', rel: 'noopener noreferrer' }, [icon('pin', 14), t(state, 'افتح الموقع على الخريطة للتأكد', 'Open on the map to check')]),
    ]),
  ], [
    button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' }),
    button({ label: t(state, 'حفظ', 'Save'), act: 'live-quick-reply-save', variant: 'primary', busy }),
  ]);
}

export function quickReplyDeleteDialog(state: AppState, id: string): HTMLElement {
  const reply: QuickReply | undefined = rowsOf(state.live.quickReplies).find((item) => item.id === id);
  const title = t(state, 'حذف الرد السريع؟', 'Delete quick reply?');
  const close = button({ label: t(state, 'إلغاء', 'Cancel'), act: 'close-dialog', variant: 'ghost' });
  if (reply === undefined) return dialogShell(state, title, [notice('warning', 'alert', t(state, 'هذا الرد لم يعد موجودًا. حدّث القائمة.', 'This reply no longer exists. Refresh the list.'))], [close]);
  return dialogShell(state, title, [
    h('p', {}, [h('strong', { dir: 'auto' }, [`/${reply.shortcut}`]), ' ', t(state, 'سيُحذف لكل الفريق. الرسائل المرسلة به من قبل تبقى كما هي.', 'will be removed for the whole team. Messages already sent with it stay as they are.')]),
    inlineError(state, state.live.error),
  ], [close, button({ label: t(state, 'حذف', 'Delete'), act: 'live-quick-reply-delete-confirm', arg: reply.id, variant: 'danger', busy: state.live.busy === `quick-reply:delete:${reply.id}` })]);
}
