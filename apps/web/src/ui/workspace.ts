import type { Campaign, ChannelConnection, RoleId } from '../data';
import { PERMISSION_KEYS } from '../data';
import { h } from '../dom';
import { channelLabel } from '../filters';
import { conversationCount, formatNumber, initials, relativeTime } from '../format';
import { can, ROLE_GRANTS, ROLE_LABELS } from '../permissions';
import type { AppState } from '../state';
import { currentActor } from '../state';
import {
  avatar,
  barRow,
  button,
  card,
  checkItem,
  isolated,
  metric,
  notice,
  pill,
  selectControl,
  stateBox,
  switchControl,
  type Tone,
} from './parts';

function t(state: AppState, ar: string, en: string): string {
  return state.lang === 'ar' ? ar : en;
}

function intro(
  state: AppState,
  heading: string,
  lede: string,
  actions: readonly HTMLElement[],
): HTMLElement {
  return h('div', { class: 'workspace__intro' }, [
    h('div', { class: 'workspace__introtext' }, [
      h('h1', { class: 'workspace__heading' }, [heading]),
      h('p', { class: 'workspace__lede' }, [lede]),
    ]),
    actions.length === 0 ? null : h('div', { class: 'workspace__actions' }, actions),
  ]);
}

const READINESS_TONE: Record<ChannelConnection['readiness'], Tone> = {
  not_configured: 'neutral',
  authorization_pending: 'warning',
  verifying: 'warning',
  connected: 'success',
  degraded: 'warning',
  reauthorization_required: 'danger',
  disconnected: 'danger',
};

function readinessLabel(state: AppState, value: ChannelConnection['readiness']): string {
  const labels: Record<ChannelConnection['readiness'], { ar: string; en: string }> = {
    not_configured: { ar: 'غير مُهيّأة', en: 'Not configured' },
    authorization_pending: { ar: 'بانتظار التفويض', en: 'Authorization pending' },
    verifying: { ar: 'جارٍ التحقق', en: 'Verifying' },
    connected: { ar: 'متصلة', en: 'Connected' },
    degraded: { ar: 'متدهورة', en: 'Degraded' },
    reauthorization_required: { ar: 'يلزم إعادة تفويض', en: 'Re-authorization required' },
    disconnected: { ar: 'مفصولة', en: 'Disconnected' },
  };
  return t(state, labels[value].ar, labels[value].en);
}

/* ---------------------------------------------------------------- channels -- */

export function renderChannels(state: AppState): HTMLElement {
  const actor = currentActor(state);
  const manage = can(actor, 'channel.manage');
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    intro(
      state,
      t(state, 'القنوات', 'Channels'),
      t(
        state,
        'كل أصل لدى المزوّد له معرّف اتصال مستقل، وحالة «متصلة» تتطلب خمسة أدلة منفصلة — وجود رمز في الحقل لا يثبت شيئًا.',
        'Every provider asset has its own connection ID, and “connected” requires five separate pieces of evidence — a non-empty token field proves nothing.',
      ),
      manage
        ? [
            button({
              label: t(state, 'ربط قناة', 'Connect a channel'),
              icon: 'plus',
              act: 'dialog',
              arg: 'connect-channel',
              variant: 'primary',
            }),
          ]
        : [],
    ),
    manage
      ? null
      : notice(
          'warning',
          'lock',
          t(
            state,
            'دورك لا يملك channel.manage — العرض للقراءة فقط، والخادم يرفض أي تعديل بغض النظر عن الواجهة.',
            'Your role lacks channel.manage — this is read-only, and the server rejects writes regardless of the UI.',
          ),
        ),
    notice(
      'info',
      'info',
      t(
        state,
        'بيانات تجريبية — لا يوجد مزوّد متصل فعليًا في هذه النسخة.',
        'Demo data — no provider is actually connected in this build.',
      ),
    ),
    h(
      'div',
      { class: 'grid2' },
      state.dataset.channels.map((connection) =>
        card(
          t(state, connection.label, connection.labelEn),
          [pill(readinessLabel(state, connection.readiness), READINESS_TONE[connection.readiness], 'shield')],
          [
            h('dl', { class: 'attrgrid' }, [
              h('dt', {}, [t(state, 'النوع', 'Kind')]),
              h('dd', {}, [channelLabel(connection.kind, state.lang)]),
              h('dt', {}, [t(state, 'الأصل', 'Asset')]),
              h('dd', {}, [isolated(connection.asset, true)]),
              h('dt', {}, [t(state, 'معرّف الاتصال', 'Connection ID')]),
              h('dd', {}, [isolated(connection.id, true)]),
              h('dt', {}, [t(state, 'نافذة الرد', 'Reply window')]),
              h('dd', {}, [isolated(`${formatNumber(connection.windowHours, state.lang)} h`)]),
            ]),
            h('div', { class: 'field' }, [
              h('span', { class: 'field__label' }, [t(state, 'أدلة الجاهزية', 'Readiness evidence')]),
              h(
                'ul',
                { class: 'checklist' },
                connection.evidence.map((item) =>
                  checkItem(t(state, item.label, item.labelEn), item.done),
                ),
              ),
            ]),
            notice('plain', 'info', t(state, connection.note, connection.noteEn)),
            h('div', { class: 'workspace__actions', style: 'margin-inline-start:0' }, [
              button({
                label: t(state, 'اختبار', 'Test'),
                icon: 'refresh',
                act: 'channel',
                arg: `test:${connection.id}`,
                small: true,
                disabled: !manage,
              }),
              connection.readiness === 'not_configured'
                ? button({
                    label: t(state, 'ربط', 'Connect'),
                    act: 'channel',
                    arg: `connect:${connection.id}`,
                    small: true,
                    variant: 'primary',
                    disabled: !manage,
                  })
                : button({
                    label: t(state, 'إعادة تفويض', 'Reconnect'),
                    act: 'channel',
                    arg: `reconnect:${connection.id}`,
                    small: true,
                    disabled: !manage,
                  }),
              button({
                label: t(state, 'فصل', 'Disconnect'),
                act: 'channel',
                arg: `disconnect:${connection.id}`,
                small: true,
                variant: 'danger',
                disabled: !manage,
              }),
            ]),
          ],
        ),
      ),
    ),
  ]);
}

/* ------------------------------------------------------------------ people -- */

export function renderPeople(state: AppState): HTMLElement {
  const actor = currentActor(state);
  const manage = can(actor, 'member.manage');
  const previewRole = (state.dialogForm.previewRole ?? 'agent') as RoleId;
  const grants = ROLE_GRANTS[previewRole];
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    intro(
      state,
      t(state, 'الأفراد والأدوار', 'People & roles'),
      t(
        state,
        'الصلاحية تُفحص بالمفتاح لا باسم الدور. الوصول الفعلي = منحة الإجراء ∩ نطاق المورد ∩ عضوية نشطة ∩ صلاحية الصندوق.',
        'Permissions are checked by key, never by role name. Effective access = action grant ∩ resource scope ∩ active membership ∩ inbox access.',
      ),
      manage
        ? [
            button({
              label: t(state, 'دعوة زميل', 'Invite a colleague'),
              icon: 'plus',
              act: 'dialog',
              arg: 'invite',
              variant: 'primary',
            }),
          ]
        : [],
    ),
    manage
      ? null
      : notice(
          'warning',
          'lock',
          t(
            state,
            'دورك لا يملك member.manage — يمكنك القراءة فقط.',
            'Your role lacks member.manage — read-only.',
          ),
        ),
    card(
      t(state, 'الأعضاء', 'Members'),
      [pill(`${state.dataset.members.length}`, 'neutral', 'users')],
      [
        h('div', { class: 'tablewrap' }, [
          h('table', { class: 'table' }, [
            h('thead', {}, [
              h('tr', {}, [
                h('th', {}, [t(state, 'العضو', 'Member')]),
                h('th', {}, [t(state, 'الدور', 'Role')]),
                h('th', {}, [t(state, 'الفرق', 'Teams')]),
                h('th', {}, [t(state, 'الصناديق', 'Inboxes')]),
                h('th', {}, [t(state, 'الحمل المفتوح', 'Open load')]),
                h('th', {}, [t(state, 'إجراءات', 'Actions')]),
              ]),
            ]),
            h(
              'tbody',
              {},
              state.dataset.members.map((member) =>
                h('tr', {}, [
                  h('td', {}, [
                    h('span', { class: 'convrow__assignee' }, [
                      avatar({ initials: initials(member.name), size: 'sm' }),
                      h('span', {}, [state.lang === 'ar' ? member.name : member.nameEn]),
                      pill(
                        member.presence === 'online'
                          ? t(state, 'متاح', 'Online')
                          : member.presence === 'away'
                            ? t(state, 'بعيد', 'Away')
                            : t(state, 'غير متصل', 'Offline'),
                        member.presence === 'online' ? 'success' : 'neutral',
                      ),
                    ]),
                  ]),
                  h('td', {}, [ROLE_LABELS[member.role][state.lang]]),
                  h('td', {}, [String(member.teamIds.length)]),
                  h('td', {}, [String(member.inboxIds.length)]),
                  h('td', {}, [isolated(formatNumber(member.openLoad, state.lang))]),
                  h('td', {}, [
                    button({
                      label: t(state, 'تعديل', 'Edit'),
                      act: 'dialog',
                      arg: `member:${member.id}`,
                      small: true,
                      disabled: !manage,
                    }),
                  ]),
                ]),
              ),
            ),
          ]),
        ]),
      ],
    ),
    card(
      t(state, 'معاينة الوصول الفعلي', 'Effective access preview'),
      [
        selectControl({
          value: previewRole,
          form: 'previewRole',
          style: 'inline-size:auto',
          ariaLabel: t(state, 'الدور المعروض', 'Previewed role'),
          options: (Object.keys(ROLE_GRANTS) as RoleId[]).map((role) => ({
            value: role,
            label: ROLE_LABELS[role][state.lang],
          })),
        }),
      ],
      [
        notice(
          'plain',
          'shield',
          t(
            state,
            'هذه معاينة للواجهة فقط. الخادم يعيد التحقق من كل مفتاح عند كل طلب، وإخفاء زر ليس ضابط تفويض.',
            'This is a UI preview only. The server re-checks every key on every request; a hidden button is not an authorization control.',
          ),
        ),
        h(
          'div',
          { class: 'rolegrid' },
          PERMISSION_KEYS.flatMap((key) => [
            h('span', { class: 'rolegrid__key' }, [isolated(key, true)]),
            grants.includes(key)
              ? pill(t(state, 'ممنوحة', 'Granted'), 'success', 'check')
              : pill(t(state, 'مرفوضة', 'Denied'), 'neutral', 'close'),
          ]),
        ),
      ],
    ),
    card(
      t(state, 'الفرق', 'Teams'),
      [
        button({
          label: t(state, 'فريق جديد', 'New team'),
          icon: 'plus',
          act: 'dialog',
          arg: 'team',
          small: true,
          disabled: !manage,
        }),
      ],
      [
        h(
          'div',
          { class: 'grid3' },
          state.dataset.teams.map((team) =>
            h('div', { class: 'metric' }, [
              h('span', { class: 'metric__label' }, [state.lang === 'ar' ? team.name : team.nameEn]),
              h('span', { class: 'metric__value' }, [
                isolated(
                  formatNumber(
                    state.dataset.members.filter((member) => member.teamIds.includes(team.id)).length,
                    state.lang,
                  ),
                ),
              ]),
              h('span', { class: 'metric__foot' }, [t(state, 'عضو', 'members')]),
            ]),
          ),
        ),
      ],
    ),
  ]);
}

/* -------------------------------------------------------------- broadcasts -- */

export function renderBroadcasts(state: AppState): HTMLElement {
  const actor = currentActor(state);
  const draft = can(actor, 'campaign.draft');
  const stateLabels: Record<Campaign['state'], { ar: string; en: string }> = {
    draft: { ar: 'مسودة', en: 'Draft' },
    validating: { ar: 'قيد التحقق', en: 'Validating' },
    ready: { ar: 'جاهزة', en: 'Ready' },
    scheduled: { ar: 'مجدولة', en: 'Scheduled' },
    running: { ar: 'قيد التنفيذ', en: 'Running' },
    paused: { ar: 'موقوفة', en: 'Paused' },
    dispatch_completed: { ar: 'اكتمل الإرسال', en: 'Dispatch completed' },
    cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  };
  const totals = state.dataset.campaigns.reduce(
    (sum, campaign) => ({
      audience: sum.audience + campaign.audienceSize,
      accepted: sum.accepted + campaign.ledger.accepted,
      pending: sum.pending + campaign.ledger.pending,
      failed: sum.failed + campaign.ledger.failed,
    }),
    { audience: 0, accepted: 0, pending: 0, failed: 0 },
  );

  return h('div', { class: 'workspace workspace--broadcasts', tabindex: '0', 'data-scroll': 'screen' }, [
    intro(
      state,
      t(state, 'الحملات', 'Broadcasts'),
      t(
        state,
        'اختَر الجمهور، جهّز الرسالة، راجع الموافقات، حدّد الموعد، ثم تابع نتيجة كل مستلم من مكان واحد.',
        'Choose the audience, prepare the message, validate consent, schedule it, then track every recipient from one place.',
      ),
      draft
        ? [
            button({ label: t(state, 'إنشاء Broadcast', 'Create broadcast'), icon: 'plus', act: 'dialog', arg: 'campaign', variant: 'primary' }),
            button({ label: t(state, 'استيراد جمهور', 'Import audience'), icon: 'users', act: 'demo', arg: t(state, 'مثال: استيراد قائمة متدربين من CSV', 'Example: import learners from CSV') }),
          ]
        : [],
    ),
    // A compact metric strip, not a KPI wall: four counts that a campaign
    // manager reads at a glance, in the shared `.metric` component. Dispatch,
    // delivery and failure stay separate quantities (business-rules §5.1).
    h('section', { class: 'grid3', 'aria-label': t(state, 'ملخص الحملات', 'Broadcast summary') }, [
      h('div', { class: 'metric' }, [
        h('span', { class: 'metric__label' }, [t(state, 'إجمالي الجمهور', 'Total audience')]),
        h('strong', { class: 'metric__value' }, [isolated(formatNumber(totals.audience, state.lang), true)]),
        h('span', { class: 'metric__foot' }, [
          t(state, 'عبر ', 'across '),
          isolated(formatNumber(state.dataset.campaigns.length, state.lang), true),
          t(state, ' حملات', ' campaigns'),
        ]),
      ]),
      h('div', { class: 'metric' }, [
        h('span', { class: 'metric__label' }, [t(state, 'قبلها المزوّد', 'Provider accepted')]),
        h('strong', { class: 'metric__value' }, [isolated(formatNumber(totals.accepted, state.lang), true)]),
        // Acceptance is not delivery (I6) — the label must not imply a receipt.
        h('span', { class: 'metric__foot' }, [t(state, 'قبول لا يعني تسليمًا', 'accepted, not yet delivered')]),
      ]),
      h('div', { class: 'metric' }, [
        h('span', { class: 'metric__label' }, [t(state, 'قيد الإرسال', 'In progress')]),
        h('strong', { class: 'metric__value' }, [isolated(formatNumber(totals.pending, state.lang), true)]),
        h('span', { class: 'metric__foot' }, [t(state, 'لم تُحسم بعد', 'no terminal result yet')]),
      ]),
      h('div', { class: 'metric' }, [
        h('span', { class: 'metric__label' }, [t(state, 'تحتاج مراجعة', 'Needs attention')]),
        h('strong', { class: 'metric__value' }, [isolated(formatNumber(totals.failed, state.lang), true)]),
        h('span', { class: 'metric__foot' }, [t(state, 'فشل إرسال', 'failed dispatches')]),
      ]),
    ]),
    h('section', { class: 'broadcast-flow' }, [
      h('div', { class: 'broadcast-flow__head' }, [
        h('div', {}, [
          h('h2', { class: 'broadcast-flow__title' }, [t(state, 'كيف تعمل الـBroadcast؟', 'How a broadcast works')]),
          h('p', { class: 'broadcast-flow__sub' }, [t(state, 'مسار واضح من الفكرة حتى التقرير النهائي', 'A clear path from idea to final report')]),
        ]),
        pill(t(state, '5 خطوات', '5 steps'), 'accent', 'sparkline'),
      ]),
      h('ol', { class: 'broadcast-steps' }, [
        ['01', t(state, 'الرسالة', 'Message'), t(state, 'قالب + متغيرات + زر إجراء', 'Template, variables and CTA')],
        ['02', t(state, 'الجمهور', 'Audience'), t(state, 'شرائح وفلاتر أو CSV', 'Segments, filters or CSV')],
        ['03', t(state, 'المراجعة', 'Validation'), t(state, 'موافقة + منع التكرار + Opt-out', 'Approval, dedupe and opt-out')],
        ['04', t(state, 'الجدولة', 'Schedule'), t(state, 'فوري أو موعد ومنطقة زمنية', 'Now or scheduled with timezone')],
        ['05', t(state, 'النتائج', 'Results'), t(state, 'قبول وتسليم وقراءة وفشل', 'Accepted, delivered, read and failed')],
      ].map(([number, title, body]) => h('li', { class: 'broadcast-step' }, [
        h('span', { class: 'broadcast-step__number' }, [number]),
        h('strong', { class: 'broadcast-step__title' }, [title]),
        h('span', { class: 'broadcast-step__body' }, [body]),
      ]))),
    ]),
    notice(
      'info',
      'info',
      t(state, 'بيانات تجريبية — الأمثلة توضح دورة العمل ولا ترسل رسائل حقيقية لأي مزوّد.', 'Demo data — these examples explain the workflow and send nothing to any provider.'),
    ),
    h('div', { class: 'broadcast-sectionhead' }, [
      h('div', {}, [
        h('h2', { class: 'broadcast-sectionhead__title' }, [t(state, 'الحملات والأمثلة', 'Campaigns and examples')]),
        h('p', { class: 'broadcast-sectionhead__sub' }, [t(state, 'كل بطاقة توضح الجمهور والرسالة والتوقيت والنتائج', 'Each card shows its audience, message, timing and results')]),
      ]),
      pill(t(state, '4 حملات', '4 campaigns'), 'neutral'),
    ]),
    h('div', { class: 'broadcast-grid' }, state.dataset.campaigns.map((campaign) => {
      const total = Math.max(campaign.audienceSize, 1);
      const example = campaign.example;
      const campaignCard = card(
        t(state, campaign.name, campaign.nameEn),
        [
          pill(t(state, stateLabels[campaign.state].ar, stateLabels[campaign.state].en), campaign.state === 'running' ? 'accent' : campaign.state === 'dispatch_completed' ? 'success' : 'neutral'),
          campaign.approved ? pill(t(state, 'معتمدة', 'Approved'), 'success', 'check') : pill(t(state, 'غير معتمدة', 'Not approved'), 'warning', 'alert'),
        ],
        [
          h('div', { class: 'broadcast-card__objective' }, [
            h('span', { class: 'broadcast-card__kicker' }, [t(state, 'الهدف', 'OBJECTIVE')]),
            h('strong', {}, [t(state, example.objective[0], example.objective[1])]),
          ]),
          h('div', { class: 'broadcast-card__example' }, [
            h('span', { class: 'broadcast-card__channel' }, [channelLabel(campaign.channel, state.lang)]),
            h('p', {}, [t(state, example.message[0], example.message[1])]),
            h('span', { class: 'broadcast-card__cta' }, [t(state, example.cta[0], example.cta[1])]),
          ]),
          h('dl', { class: 'broadcast-card__details' }, [
            h('div', {}, [h('dt', {}, [t(state, 'الجمهور', 'Audience')]), h('dd', {}, [t(state, example.audience[0], example.audience[1])])]),
            h('div', {}, [h('dt', {}, [t(state, 'التوقيت', 'Timing')]), h('dd', {}, [t(state, example.timing[0], example.timing[1])])]),
            h('div', {}, [h('dt', {}, [t(state, 'القالب', 'Template')]), h('dd', {}, [isolated(campaign.templateRevision, true)])]),
            h('div', {}, [h('dt', {}, [t(state, 'لقطة الجمهور', 'Audience snapshot')]), h('dd', {}, [campaign.snapshotAt === null ? t(state, 'لم تُثبَّت بعد', 'Not fixed yet') : isolated(`${formatNumber(campaign.audienceSize, state.lang)} · ${relativeTime(campaign.snapshotAt, state.dataset.now, state.lang)}`)])]),
          ]),
          h('div', { class: 'bars broadcast-card__bars' }, [
            barRow(t(state, 'مقبولة', 'Accepted'), campaign.ledger.accepted / total, formatNumber(campaign.ledger.accepted, state.lang)),
            barRow(t(state, 'قيد الانتظار', 'Pending'), campaign.ledger.pending / total, formatNumber(campaign.ledger.pending, state.lang), true),
            barRow(t(state, 'متخطّاة', 'Skipped'), campaign.ledger.skipped / total, formatNumber(campaign.ledger.skipped, state.lang)),
            barRow(t(state, 'فاشلة', 'Failed'), campaign.ledger.failed / total, formatNumber(campaign.ledger.failed, state.lang)),
            barRow(t(state, 'نتيجة غير معروفة', 'Outcome unknown'), campaign.ledger.unknown / total, formatNumber(campaign.ledger.unknown, state.lang)),
          ]),
          notice('plain', 'info', t(state, 'القبول من المزوّد ليس تسليمًا، والتسليم ليس قراءة. كل مستلم له سجل مستقل.', 'Provider acceptance is not delivery, and delivery is not read. Every recipient has an independent ledger.')),
          h('div', { class: 'workspace__actions broadcast-card__actions', style: 'margin-inline-start:0' }, [
            button({ label: t(state, 'تعديل', 'Edit'), act: 'campaign', arg: `edit:${campaign.id}`, small: true, disabled: !draft }),
            button({ label: t(state, 'إطلاق', 'Launch'), act: 'campaign', arg: `launch:${campaign.id}`, small: true, variant: 'primary', disabled: !draft }),
            button({ label: t(state, 'سجل المستلمين', 'Recipient ledger'), act: 'campaign', arg: `ledger:${campaign.id}`, small: true, disabled: !draft }),
          ]),
        ],
      );
      campaignCard.classList.add('broadcast-card');
      return campaignCard;
    })),
  ]);
}

/* --------------------------------------------------------------- analytics -- */

export function renderAnalytics(state: AppState): HTMLElement {
  const actor = currentActor(state);
  if (!can(actor, 'report.read')) {
    return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
      stateBox({
        kind: 'denied',
        iconName: 'lock',
        title: t(state, 'التقارير غير متاحة لدورك', 'Reports are not available to your role'),
        body: t(state, 'المنحة report.read غير مسندة.', 'The report.read grant is not assigned.'),
      }),
    ]);
  }
  const open = state.conversations.filter((entry) => entry.status === 'open').length;
  const unassigned = state.conversations.filter((entry) => entry.assigneeId === null).length;
  const breached = state.conversations.filter((entry) => entry.sla === 'breached').length;
  const resolved = state.conversations.filter((entry) => entry.status === 'resolved').length;
  const denominator = state.conversations.length;
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    intro(
      state,
      t(state, 'التقارير', 'Analytics'),
      t(
        state,
        'كل رقم هنا يحمل مقامه المنشور ووقت تحديثه. لا نسب بلا مقام، ولا إيصالات مفترضة.',
        'Every number carries its published denominator and freshness. No ratios without a denominator, and no assumed receipts.',
      ),
      [
        button({
          label: t(state, 'تصدير CSV', 'Export CSV'),
          icon: 'download',
          act: 'demo',
          arg: t(state, 'التصدير غير مفعّل في العرض التجريبي', 'Export is disabled in the demo'),
        }),
      ],
    ),
    notice(
      'info',
      'info',
      t(
        state,
        `بيانات تجريبية — محسوبة من ${conversationCount(denominator, state.lang)} في هذه النسخة، وليست من نظام إنتاج.`,
        `Demo data — computed from ${conversationCount(denominator, state.lang)} in this build, not from a production system.`,
      ),
    ),
    h('div', { class: 'grid3' }, [
      metric(
        t(state, 'محادثات مفتوحة', 'Open conversations'),
        formatNumber(open, state.lang),
        t(state, `من إجمالي ${formatNumber(denominator, state.lang)}`, `of ${formatNumber(denominator, state.lang)} total`),
      ),
      metric(
        t(state, 'غير مُسندة', 'Unassigned'),
        formatNumber(unassigned, state.lang),
        t(state, 'تُعرض كبطاقات طابور فقط للموظفين', 'Shown to agents as queue cards only'),
      ),
      metric(
        t(state, 'تجاوزت الـ SLA', 'SLA breached'),
        formatNumber(breached, state.lang),
        t(state, 'حسب سياسة الفريق النشطة', 'Per the active team policy'),
      ),
      metric(
        t(state, 'محلولة', 'Resolved'),
        formatNumber(resolved, state.lang),
        t(state, 'كل إعادة فتح تبدأ حلقة قياس جديدة', 'Each reopen starts a new reporting episode'),
      ),
    ]),
    card(
      t(state, 'التوزيع حسب القناة', 'Distribution by channel'),
      [pill(t(state, 'محدَّث الآن', 'Fresh now'), 'neutral', 'clock')],
      [
        h(
          'div',
          { class: 'bars' },
          state.dataset.inboxes.map((inbox) => {
            const count = state.conversations.filter((entry) => entry.inboxId === inbox.id).length;
            return barRow(
              state.lang === 'ar' ? inbox.name : inbox.nameEn,
              count / Math.max(denominator, 1),
              formatNumber(count, state.lang),
            );
          }),
        ),
      ],
    ),
    card(
      t(state, 'حمل الفريق', 'Team workload'),
      [],
      [
        h(
          'div',
          { class: 'bars' },
          state.dataset.members
            .filter((member) => member.inboxIds.length > 0)
            .map((member) =>
              barRow(
                state.lang === 'ar' ? member.name : member.nameEn,
                member.openLoad / 15,
                formatNumber(member.openLoad, state.lang),
                member.openLoad > 10,
              ),
            ),
        ),
      ],
    ),
    card(
      t(state, 'الإيصالات', 'Receipts'),
      [],
      [
        notice(
          'warning',
          'alert',
          t(
            state,
            'إيصالات القراءة غير مدعومة على كل القنوات. غير المدعوم يُعرض «غير متاح» ولا يُحسب صفرًا ولا 0%.',
            'Read receipts are not supported on every channel. Unsupported is shown as “not available” — never 0 and never 0%.',
          ),
        ),
        h('dl', { class: 'attrgrid' }, [
          h('dt', {}, [t(state, 'واتساب — تسليم', 'WhatsApp — delivered')]),
          h('dd', {}, [pill(t(state, 'مدعوم', 'Supported'), 'success', 'check')]),
          h('dt', {}, [t(state, 'إنستجرام — قراءة', 'Instagram — read')]),
          h('dd', {}, [pill(t(state, 'غير متاح', 'Not available'), 'neutral', 'info')]),
          h('dt', {}, [t(state, 'ماسنجر — قراءة', 'Messenger — read')]),
          h('dd', {}, [pill(t(state, 'غير متاح', 'Not available'), 'neutral', 'info')]),
        ]),
      ],
    ),
  ]);
}

/* ---------------------------------------------------------------- settings -- */

export function renderSettings(state: AppState): HTMLElement {
  const actor = currentActor(state);
  const form = state.dialogForm;
  return h('div', { class: 'workspace', tabindex: '0', 'data-scroll': 'screen' }, [
    intro(
      state,
      t(state, 'الإعدادات', 'Settings'),
      t(
        state,
        'إعدادات المساحة والاحتفاظ والخصوصية. التغييرات هنا عرض تجريبي ولا تُرسل إلى أي خادم.',
        'Workspace, retention and privacy settings. Changes here are a demo and are not sent to any server.',
      ),
      [
        button({
          label: t(state, 'حفظ', 'Save'),
          icon: 'check',
          act: 'demo',
          arg: t(state, 'حُفظت الإعدادات محليًا (عرض تجريبي)', 'Settings saved locally (demo)'),
          variant: 'primary',
        }),
      ],
    ),
    h('div', { class: 'grid2' }, [
      card(
        t(state, 'المساحة', 'Workspace'),
        [],
        [
          h('label', { class: 'field' }, [
            h('span', { class: 'field__label' }, [t(state, 'اسم الشركة', 'Company name')]),
            h('input', {
              class: 'input',
              type: 'text',
              value: form.company ?? 'Digital School',
              'data-act': 'form',
              'data-form': 'company',
            }),
          ]),
          h('label', { class: 'field' }, [
            h('span', { class: 'field__label' }, [t(state, 'المنطقة الزمنية', 'Timezone')]),
            selectControl({
              value: form.tz ?? 'Africa/Cairo',
              form: 'tz',
              options: ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London'].map((zone) => ({
                value: zone,
                label: zone,
              })),
            }),
          ]),
          h('label', { class: 'field' }, [
            h('span', { class: 'field__label' }, [t(state, 'لغة الواجهة', 'Interface language')]),
            selectControl({
              value: state.lang,
              act: 'lang',
              options: [
                { value: 'ar', label: 'العربية' },
                { value: 'en', label: 'English' },
              ],
            }),
          ]),
          notice(
            'plain',
            'clock',
            t(
              state,
              'كل الطوابع الزمنية تُخزَّن بتوقيت UTC، وكل جدول يحمل منطقة زمنية IANA صريحة.',
              'All timestamps are stored in UTC and every schedule carries an explicit IANA timezone.',
            ),
          ),
        ],
      ),
      card(
        t(state, 'ساعات العمل', 'Business hours'),
        [],
        [
          h('div', { class: 'field' }, [
            switchControl(
              t(state, 'إيقاف مؤقّتات الـ SLA خارج ساعات العمل', 'Pause SLA timers outside business hours'),
              (form.slaPause ?? 'on') === 'on',
              'form-toggle',
              `slaPause:${(form.slaPause ?? 'on') === 'on' ? 'off' : 'on'}`,
            ),
          ]),
          h('div', { class: 'field' }, [
            switchControl(
              t(state, 'رد آلي خارج ساعات العمل', 'Away auto-reply'),
              (form.away ?? 'off') === 'on',
              'form-toggle',
              `away:${(form.away ?? 'off') === 'on' ? 'off' : 'on'}`,
            ),
          ]),
          h('dl', { class: 'attrgrid' }, [
            h('dt', {}, [t(state, 'الأحد–الخميس', 'Sun–Thu')]),
            h('dd', {}, [isolated('09:00 – 18:00')]),
            h('dt', {}, [t(state, 'الجمعة', 'Friday')]),
            h('dd', {}, [t(state, 'مغلق', 'Closed')]),
            h('dt', {}, [t(state, 'السبت', 'Saturday')]),
            h('dd', {}, [isolated('11:00 – 16:00')]),
          ]),
        ],
      ),
      card(
        t(state, 'الاحتفاظ والخصوصية', 'Retention & privacy'),
        [],
        [
          h('label', { class: 'field' }, [
            h('span', { class: 'field__label' }, [t(state, 'مدة الاحتفاظ بالمحادثات', 'Conversation retention')]),
            selectControl({
              value: form.retention ?? '24',
              form: 'retention',
              options: ['12', '24', '36'].map((months) => ({
                value: months,
                label: t(state, `${months} شهرًا`, `${months} months`),
              })),
            }),
          ]),
          notice(
            'warning',
            'shield',
            t(
              state,
              'إزالة الحجب تتطلب سير عمل موافقة جديد صريح — لا يوجد زر «إلغاء حجب» هنا ولا في أي مكان.',
              'Removing suppression requires an explicit new opt-in workflow — there is no “unsuppress” button here or anywhere.',
            ),
          ),
          h('div', { class: 'field' }, [
            switchControl(
              t(state, 'إخفاء أرقام الهواتف في القوائم', 'Mask phone numbers in lists'),
              (form.maskPhones ?? 'on') === 'on',
              'form-toggle',
              `maskPhones:${(form.maskPhones ?? 'on') === 'on' ? 'off' : 'on'}`,
            ),
          ]),
        ],
      ),
      card(
        t(state, 'جلستك', 'Your session'),
        [pill(ROLE_LABELS[state.role][state.lang], 'accent', 'user')],
        [
          h('dl', { class: 'attrgrid' }, [
            h('dt', {}, [t(state, 'الاسم', 'Name')]),
            h('dd', {}, [state.lang === 'ar' ? actor.name : actor.nameEn]),
            h('dt', {}, [t(state, 'الصناديق المسموحة', 'Allowed inboxes')]),
            h('dd', {}, [isolated(String(actor.inboxIds.length))]),
            h('dt', {}, [t(state, 'الفرق', 'Teams')]),
            h('dd', {}, [isolated(String(actor.teamIds.length))]),
          ]),
          notice(
            'plain',
            'shield',
            t(
              state,
              'سحب العضوية ينعكس على كل الجلسات والاتصالات المفتوحة خلال 30 ثانية.',
              'Revoking a membership reaches every open session and socket within 30 seconds.',
            ),
          ),
          h('div', { class: 'workspace__actions', style: 'margin-inline-start:0' }, [
            button({
              label: t(state, 'إنهاء كل الجلسات الأخرى', 'Sign out other sessions'),
              act: 'demo',
              arg: t(state, 'أُنهيت الجلسات الأخرى (عرض تجريبي)', 'Other sessions ended (demo)'),
              small: true,
              variant: 'danger',
            }),
          ]),
        ],
      ),
    ]),
  ]);
}
