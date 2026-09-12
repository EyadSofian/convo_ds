import type { Child } from '../dom';
import { h } from '../dom';
import type { AppState } from '../state';
import { rowsOf } from '../live/store';
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

  if (dialog.kind === 'campaign-test-send') {
    const campaign = rowsOf(state.live.campaigns).find((entry) => entry.id === dialog.arg);
    const recipients = campaign === undefined ? [] : rowsOf(state.live.testRecipients)
      .filter((entry) => entry.connection_id === campaign.connection_id);
    const selected = state.dialogForm.campaignTestRecipient ?? recipients[0]?.id ?? '';
    const resourceNotice: Child = state.live.testRecipients.status === 'loading' || state.live.testRecipients.status === 'idle'
      ? notice('plain', 'clock', t(state, 'جارٍ تحميل المستلمين المصرح لهم…', 'Loading authorized recipients…'))
      : state.live.testRecipients.status === 'error'
        ? notice('warning', 'alert', state.live.testRecipients.error.message)
        : recipients.length === 0
          ? notice('warning', 'shield', t(state,
              'لا يوجد مستلم مصرح لهذه القناة. يضيف Owner أو Admin هوية اختبار من شاشة القنوات أولًا.',
              'No recipient is authorized for this channel. An Owner or Admin must add one from Channels first.'))
          : notice('plain', 'shield', t(state,
              'سيُرسل الإصدار الظاهر إلى هذا المستلم فقط، عبر نفس فحص القناة والنافذة والمحوّل المستخدم في الإنتاج.',
              'The rendered revision will go only to this recipient through the same channel, window and adapter checks used in production.'));
    return dialogShell(
      t(state, 'إرسال اختبار', 'Send a test'),
      campaign === undefined
        ? [notice('warning', 'alert', t(state, 'الحملة لم تعد موجودة. أعد تحميل القائمة.', 'The campaign no longer exists. Reload the list.'))]
        : [
            h('p', { style: 'margin:0' }, [campaign.name]),
            resourceNotice,
            ...(recipients.length === 0 ? [] : [field(
              t(state, 'مستلم الاختبار', 'Test recipient'),
              selectInput('campaignTestRecipient', selected, recipients.map((recipient) => ({
                value: recipient.id, label: `${recipient.label} · ${recipient.peer_identity}`,
              }))),
            )]),
            state.live.error === null ? null : notice('warning', 'alert', `${state.live.error.message}${state.live.error.requestId === null ? '' : ` · ${state.live.error.requestId}`}`),
          ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({ label: t(state, 'إضافة إلى الطابور', 'Queue test'), act: 'live-campaign-test-send',
          arg: campaign?.id ?? '', variant: 'primary',
          disabled: campaign === undefined || recipients.length === 0 || selected === '' || state.live.busy !== null }),
      ],
    );
  }

  if (dialog.kind === 'campaign' || dialog.kind === 'campaign-edit') {
    const campaign = dialog.kind === 'campaign-edit'
      ? rowsOf(state.live.campaigns).find((entry) => entry.id === dialog.arg)
      : undefined;
    const connections = rowsOf(state.live.connections).filter((connection) =>
      connection.status === 'healthy' || connection.id === campaign?.connection_id);
    const initialMessage = typeof campaign?.content['text'] === 'string' ? campaign.content['text'] : '';
    const initialSearch = typeof campaign?.audience_filter['search'] === 'string' ? campaign.audience_filter['search'] : '';
    if (dialog.kind === 'campaign-edit' && campaign === undefined) {
      return dialogShell(
        t(state, 'تعديل الحملة', 'Edit campaign'),
        [notice('warning', 'alert', t(state, 'الحملة لم تعد موجودة. أعد تحميل القائمة.', 'The campaign no longer exists. Reload the list.'))],
        [h('span', { class: 'dialog__footerspacer' }), closeButton(state)],
      );
    }
    return dialogShell(
      campaign === undefined ? t(state, 'حملة جديدة', 'New campaign') : t(state, 'تعديل الحملة', 'Edit campaign'),
      [
        field(t(state, 'اسم الحملة', 'Campaign name'), textInput('campaignName', state.dialogForm.campaignName ?? campaign?.name ?? '', t(state, 'مثال: تذكير المحاضرة المباشرة', 'e.g. Live session reminder'))),
        field(
          t(state, 'القناة', 'Channel'),
          selectInput('campaignConnection', state.dialogForm.campaignConnection ?? campaign?.connection_id ?? (connections[0]?.id ?? ''),
            connections.map((connection) => ({ value: connection.id, label: connection.display_name }))),
          t(
            state,
            'قالب واتساب ليس قالب ماسنجر — لا شيء يُنسخ بين القنوات.',
            'A WhatsApp template is not a Messenger template — nothing is copied across channels.',
          ),
        ),
        field(t(state, 'الهدف', 'Objective'), textInput('campaignObjective', state.dialogForm.campaignObjective ?? campaign?.objective ?? '', t(state, 'مثال: تسجيل الدورة', 'e.g. Course enrolment'))),
        field(t(state, 'نص الرسالة', 'Message'), h('textarea', {
          class: 'field__input', rows: '4', 'data-act': 'form', 'data-form': 'campaignMessage',
          placeholder: t(state, 'اكتب الرسالة التي سيستلمها الطالب', 'Write the message the learner will receive'),
        }, [state.dialogForm.campaignMessage ?? initialMessage])),
        field(t(state, 'بحث الجمهور', 'Audience search'), textInput('campaignSearch', state.dialogForm.campaignSearch ?? initialSearch, t(state, 'اتركه فارغًا لكل جهات الاتصال', 'Leave blank for all contacts'))),
        notice(
          'warning',
          'alert',
          t(
            state,
            connections.length === 0 ? 'اربط قناة سليمة أولًا، ثم أنشئ المسودة وثبّت الجمهور واعتمد النسخة قبل الإطلاق.' : campaign === undefined ? 'بعد إنشاء المسودة: ثبّت الجمهور، اعتمد النسخة، ثم أطلقها.' : 'أي تغيير في الرسالة أو الجمهور ينشئ مراجعة جديدة ويلزم تثبيت الجمهور واعتمادها من جديد.',
            connections.length === 0 ? 'Connect a healthy channel first, then create, freeze, approve and launch.' : campaign === undefined ? 'After creating the draft: freeze the audience, approve the revision, then launch.' : 'A message or audience change creates a new revision that must be frozen and approved again.',
          ),
        ),
      ],
      [
        h('span', { class: 'dialog__footerspacer' }),
        closeButton(state),
        button({
          label: campaign === undefined ? t(state, 'إنشاء المسودة', 'Create draft') : t(state, 'حفظ المراجعة', 'Save revision'),
          act: campaign === undefined ? 'live-campaign-create' : 'live-campaign-update',
          ...(campaign === undefined ? {} : { arg: campaign.id }),
          variant: 'primary',
          disabled: connections.length === 0 || state.live.busy !== null,
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
