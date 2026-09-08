import type { Child } from '../dom';
import { h } from '../dom';
import { activeFilterCount } from '../filters';
import type { AppState } from '../state';
import { renderFilterDialogBody } from './inbox';
import { button, dialogShell, field, notice, selectInput, textInput } from './parts';

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

function closeButton(state: AppState): HTMLElement {
  return button({ label: t(state, 'إغلاق', 'Close'), act: 'close-dialog' });
}

/** Returns the dialog layer for the current state, or `null` when none is open. */
export function renderDialog(state: AppState): HTMLElement | null {
  const dialog = state.dialog;
  if (dialog === null) return null;

  if (dialog.kind === 'filters') {
    const count = activeFilterCount(state.filter);
    return dialogShell(
      t(state, 'تصفية المحادثات', 'Filter conversations'),
      renderFilterDialogBody(state),
      [
        h('span', { class: 'field__hint' }, [
          t(state, `${count} مرشّح نشط`, `${count} active filter${count === 1 ? '' : 's'}`),
        ]),
        h('span', { class: 'dialog__footerspacer' }),
        button({ label: t(state, 'مسح الكل', 'Clear all'), act: 'clear-filters' }),
        button({ label: t(state, 'تم', 'Done'), act: 'close-dialog', variant: 'primary' }),
      ],
    );
  }

  if (dialog.kind === 'save-view') {
    return dialogShell(
      t(state, 'حفظ عرض مخصّص', 'Save a custom view'),
      [
        field(
          t(state, 'اسم العرض', 'View name'),
          textInput('name', state.dialogForm.name ?? '', t(state, 'مثال: تأخيرات التفعيل اليوم', 'e.g. Activation delays today')),
          t(state, 'يُحفظ مع المرشّحات النشطة الآن.', 'Saved together with the filters in force right now.'),
        ),
        field(
          t(state, 'من يراه', 'Who can see it'),
          selectInput('scope', state.dialogForm.scope ?? 'private', [
            { value: 'private', label: t(state, 'خاص بي', 'Private') },
            { value: 'team', label: t(state, 'فريقي', 'My team') },
            { value: 'workspace', label: t(state, 'كل المساحة', 'Whole workspace') },
          ]),
        ),
        notice(
          'plain',
          'bookmark',
          t(
            state,
            'العرض يخزّن استعلامًا، لا نسخة من المحادثات — النتائج تتغيّر مع البيانات.',
            'A view stores a query, not a copy of the conversations — results move with the data.',
          ),
        ),
      ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({ label: t(state, 'حفظ العرض', 'Save view'), act: 'save-view', variant: 'primary' }),
      ],
    );
  }

  if (dialog.kind === 'resolve') {
    const dispositions = [
      t(state, 'تم التسليم', 'Delivered'),
      t(state, 'تم الاسترداد', 'Refunded'),
      t(state, 'أُجيب الاستفسار', 'Question answered'),
      t(state, 'إلغاء من العميل', 'Customer cancelled'),
      t(state, 'مكرّرة', 'Duplicate'),
    ];
    return dialogShell(
      t(state, 'حلّ المحادثة', 'Resolve conversation'),
      [
        h('p', { style: 'margin:0' }, [
          t(
            state,
            'الحل يتطلب تصنيفًا. لا يمكن إغلاق محادثة بدونه، ولا يُعلَّم غير المقروء كمقروء تلقائيًا.',
            'Resolving requires a disposition. A conversation cannot close without one, and unread is not silently marked read.',
          ),
        ]),
        h(
          'div',
          { class: 'labelset' },
          dispositions.map((label) =>
            button({ label, act: 'resolve', arg: label, variant: 'default', small: true }),
          ),
        ),
      ],
      [h('span', { class: 'dialog__footerspacer' }), closeButton(state)],
    );
  }

  if (dialog.kind === 'snooze') {
    const options: readonly { readonly label: string; readonly minutes: number }[] = [
      { label: t(state, 'ساعة واحدة', '1 hour'), minutes: 60 },
      { label: t(state, '3 ساعات', '3 hours'), minutes: 180 },
      { label: t(state, 'غدًا 08:00', 'Tomorrow 08:00'), minutes: 20 * 60 },
      { label: t(state, 'الأسبوع القادم', 'Next week'), minutes: 7 * 24 * 60 },
    ];
    return dialogShell(
      t(state, 'تأجيل المحادثة', 'Snooze conversation'),
      [
        h('p', { style: 'margin:0' }, [
          t(
            state,
            'وقت الاستيقاظ يُخزَّن بتوقيت UTC مع منطقة المصدر Africa/Cairo، ووصول رسالة من العميل يوقظها فورًا.',
            'The wake time is stored in UTC with its source zone Africa/Cairo, and an inbound message wakes it immediately.',
          ),
        ]),
        h(
          'div',
          { class: 'labelset' },
          options.map((option) =>
            button({ label: option.label, act: 'snooze', arg: String(option.minutes), small: true }),
          ),
        ),
      ],
      [h('span', { class: 'dialog__footerspacer' }), closeButton(state)],
    );
  }

  if (dialog.kind === 'connect-channel') {
    return dialogShell(
      t(state, 'ربط قناة جديدة', 'Connect a new channel'),
      [
        field(
          t(state, 'المزوّد', 'Provider'),
          selectInput('provider', state.dialogForm.provider ?? 'whatsapp', [
            { value: 'whatsapp', label: 'WhatsApp Business Platform' },
            { value: 'instagram', label: 'Instagram (Instagram Login)' },
            { value: 'messenger', label: 'Messenger (Facebook Page)' },
          ]),
        ),
        field(
          t(state, 'اسم داخلي', 'Internal label'),
          textInput('label', state.dialogForm.label ?? '', t(state, 'مثال: خط الجملة', 'e.g. Wholesale line')),
          t(state, 'يظهر داخل CONVO فقط، لا لدى المزوّد.', 'Shown inside CONVO only, never at the provider.'),
        ),
        notice(
          'warning',
          'shield',
          t(
            state,
            'الربط يبدأ بتفويض OAuth حقيقي لدى المزوّد. لا يمكن إتمامه في هذه النسخة التجريبية، ولن نعرض «متصلة» قبل اكتمال الأدلة الخمسة.',
            'Connecting starts with a real OAuth grant at the provider. It cannot complete in this demo, and “connected” is never shown before all five pieces of evidence exist.',
          ),
        ),
      ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({
          label: t(state, 'بدء التفويض', 'Start authorization'),
          act: 'channel',
          arg: 'connect:new',
          variant: 'primary',
        }),
      ],
    );
  }

  if (dialog.kind === 'invite') {
    return dialogShell(
      t(state, 'دعوة زميل', 'Invite a colleague'),
      [
        field(
          t(state, 'البريد الإلكتروني', 'Email'),
          textInput('email', state.dialogForm.email ?? '', 'name@company.com'),
        ),
        field(
          t(state, 'الدور', 'Role'),
          selectInput('role', state.dialogForm.role ?? 'agent', [
            { value: 'agent', label: t(state, 'موظف خدمة', 'Agent') },
            { value: 'supervisor', label: t(state, 'مشرف', 'Supervisor') },
            { value: 'admin', label: t(state, 'مسؤول', 'Admin') },
            { value: 'analyst', label: t(state, 'محلل', 'Analyst') },
          ]),
          t(
            state,
            'لا يمكنك منح ما لا تملكه — الدعوة محدودة بسقف تفويضك.',
            'You cannot grant what you do not hold — invitations are capped by your own delegation ceiling.',
          ),
        ),
        notice(
          'plain',
          'shield',
          t(
            state,
            'لا توجد كلمة مرور افتراضية على الإطلاق؛ الدعوة رمز أحادي الاستخدام.',
            'No default password ever exists; the invitation is a single-use token.',
          ),
        ),
      ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({
          label: t(state, 'إرسال الدعوة', 'Send invitation'),
          act: 'demo',
          arg: t(state, 'الدعوة معطّلة في العرض التجريبي', 'Invitations are disabled in the demo'),
          variant: 'primary',
        }),
      ],
    );
  }

  if (dialog.kind === 'member') {
    const member = state.dataset.members.find((entry) => entry.id === dialog.arg);
    const body: Child[] =
      member === undefined
        ? [h('p', { style: 'margin:0' }, [t(state, 'العضو غير موجود.', 'Member not found.')])]
        : [
            field(
              t(state, 'الدور', 'Role'),
              selectInput('role', state.dialogForm.role ?? member.role, [
                { value: 'agent', label: t(state, 'موظف خدمة', 'Agent') },
                { value: 'supervisor', label: t(state, 'مشرف', 'Supervisor') },
                { value: 'admin', label: t(state, 'مسؤول', 'Admin') },
              ]),
            ),
            notice(
              'warning',
              'alert',
              t(
                state,
                'خفض دور آخر مالك مرفوض، وسحب العضوية ينهي كل الجلسات خلال 30 ثانية.',
                'Demoting the last Owner is rejected, and revoking a membership ends every session within 30 seconds.',
              ),
            ),
          ];
    return dialogShell(
      member === undefined
        ? t(state, 'تعديل عضو', 'Edit member')
        : t(state, `تعديل ${member.name}`, `Edit ${member.nameEn}`),
      body,
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({
          label: t(state, 'حفظ', 'Save'),
          act: 'demo',
          arg: t(state, 'تعديل الأعضاء معطّل في العرض التجريبي', 'Member edits are disabled in the demo'),
          variant: 'primary',
        }),
      ],
    );
  }

  if (dialog.kind === 'team') {
    return dialogShell(
      t(state, 'فريق جديد', 'New team'),
      [
        field(t(state, 'اسم الفريق', 'Team name'), textInput('teamName', state.dialogForm.teamName ?? '', t(state, 'مثال: المرتجعات', 'e.g. Returns'))),
        field(
          t(state, 'صندوق الوارد الأساسي', 'Primary inbox'),
          selectInput(
            'teamInbox',
            state.dialogForm.teamInbox ?? (state.dataset.inboxes[0]?.id ?? ''),
            state.dataset.inboxes.map((inbox) => ({
              value: inbox.id,
              label: state.lang === 'ar' ? inbox.name : inbox.nameEn,
            })),
          ),
        ),
      ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({
          label: t(state, 'إنشاء', 'Create'),
          act: 'demo',
          arg: t(state, 'إنشاء الفرق معطّل في العرض التجريبي', 'Team creation is disabled in the demo'),
          variant: 'primary',
        }),
      ],
    );
  }

  if (dialog.kind === 'campaign') {
    return dialogShell(
      t(state, 'حملة جديدة', 'New campaign'),
      [
        field(t(state, 'اسم الحملة', 'Campaign name'), textInput('campaignName', state.dialogForm.campaignName ?? '', t(state, 'مثال: تذكير المحاضرة المباشرة', 'e.g. Live session reminder'))),
        field(
          t(state, 'القناة', 'Channel'),
          selectInput('campaignChannel', state.dialogForm.campaignChannel ?? 'whatsapp', [
            { value: 'whatsapp', label: 'WhatsApp' },
            { value: 'messenger', label: 'Messenger' },
          ]),
          t(
            state,
            'قالب واتساب ليس قالب ماسنجر — لا شيء يُنسخ بين القنوات.',
            'A WhatsApp template is not a Messenger template — nothing is copied across channels.',
          ),
        ),
        notice(
          'warning',
          'alert',
          t(
            state,
            'الخطوات التالية: الجمهور ← المحتوى ← الجدولة والميزانية ← المراجعة. الاعتماد سجل منفصل مرتبط بالمراجعة، و«جاهزة» لا تعني «معتمدة».',
            'Next steps: audience → content → schedule & budget → review. Approval is a separate revision-bound record, and “ready” is not “approved”.',
          ),
        ),
      ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({
          label: t(state, 'التالي: الجمهور', 'Next: audience'),
          act: 'demo',
          arg: t(state, 'معالج الحملات معطّل في العرض التجريبي', 'The campaign wizard is disabled in the demo'),
          variant: 'primary',
        }),
      ],
    );
  }

  return dialogShell(
    t(state, 'غير متاح', 'Not available'),
    [h('p', { style: 'margin:0' }, [t(state, 'لا يوجد محتوى لهذا الحوار.', 'No content for this dialog.')])],
    [h('span', { class: 'dialog__footerspacer' }), closeButton(state)],
  );
}
