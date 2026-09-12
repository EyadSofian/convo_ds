import type { Child } from '../dom';
import type { Campaign, CampaignState } from '../api/campaigns';
import { h } from '../dom';
import { dateFormat, formatNumber, numberFormat } from '../format';
import { can, ROLE_LABELS } from '../permissions';
import type { AppState } from '../state';
import { currentActor } from '../state';
import {
  barRow,
  button,
  card,
  isolated,
  metric,
  notice,
  pill,
  selectControl,
  stateBox,
  switchControl,
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
    h('div', { class: 'workspace__actions' }, actions),
  ]);
}

/* ---------------------------------------------------------------- channels -- */

export function renderBroadcasts(state: AppState): HTMLElement {
  const live = state.live;
  const actor = currentActor(state);
  const mayDraft = can(actor, 'campaign.draft');
  const mayApprove = can(actor, 'campaign.approve');
  const mayControl = can(actor, 'campaign.control');
  const campaigns = live.campaigns.status === 'ready' ? live.campaigns.value : [];
  const totals = campaigns.reduce((sum, campaign) => ({
    total: sum.total + (campaign.audience?.total ?? 0),
    eligible: sum.eligible + (campaign.audience?.eligible ?? 0),
    excluded: sum.excluded + (campaign.audience?.excluded ?? 0),
  }), { total: 0, eligible: 0, excluded: 0 });

  const body: Child[] = [];
  if (live.session.status === 'unknown' || (live.session.status === 'signed_in' && live.session.tenantId !== null && (live.campaigns.status === 'idle' || live.campaigns.status === 'loading'))) {
    body.push(h('div', { class: 'skeleton', 'aria-busy': 'true' }, [
      h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
      h('div', { class: 'skeletonrow' }, [h('div', { class: 'skeletonrow__lines' })]),
    ]));
  } else if (live.session.status === 'signed_out') {
    body.push(stateBox({ kind: 'denied', iconName: 'lock', title: t(state, 'تحتاج جلسة', 'You need a session'),
      body: t(state, 'سجّل الدخول لعرض الحملات الحقيقية.', 'Sign in to view real campaigns.'),
      actionLabel: t(state, 'إعادة المحاولة', 'Try again'), act: 'live-campaigns-reload' }));
  } else if (live.session.tenantId === null) {
    body.push(stateBox({ kind: 'info', iconName: 'users', title: t(state, 'لا توجد عضوية نشطة', 'No active membership'),
      body: t(state, 'لا توجد شركة نشطة لعرض حملاتها.', 'There is no active company whose campaigns can be shown.') }));
  } else if (live.campaigns.status === 'error') {
    body.push(stateBox({ kind: 'denied', iconName: 'alert', title: live.campaigns.error.message,
      body: live.campaigns.error.requestId === null ? t(state, 'تعذر الاتصال بالخادم.', 'The server could not be reached.') : `Request ID: ${live.campaigns.error.requestId}`,
      actionLabel: t(state, 'إعادة التحميل', 'Reload'), act: 'live-campaigns-reload' }));
  } else if (campaigns.length === 0) {
    body.push(stateBox({ kind: 'empty', iconName: 'broadcasts', title: t(state, 'لا توجد حملات بعد', 'No campaigns yet'),
      body: t(state, 'أنشئ مسودة، ثبّت جمهورها، اعتمد النسخة، ثم أطلقها.', 'Create a draft, freeze its audience, approve the revision, then launch it.') }));
  } else {
    body.push(h('div', { class: 'broadcast-grid' }, campaigns.map((campaign) => campaignCard(state, campaign, mayDraft, mayApprove, mayControl))));
  }

  return h('div', { class: 'workspace workspace--broadcasts', tabindex: '0', 'data-scroll': 'screen' }, [
    intro(state, t(state, 'الحملات', 'Broadcasts'),
      t(state, 'مسودة واضحة، جمهور ثابت، اعتماد مرتبط بالنسخة، ثم سجل مستقل لكل مستلم.',
        'A clear draft, frozen audience, revision-bound approval, then one ledger per recipient.'),
      [button({ label: t(state, 'تحديث', 'Reload'), icon: 'refresh', act: 'live-campaigns-reload', small: true, disabled: live.busy !== null }),
       ...(mayDraft ? [button({ label: t(state, 'حملة جديدة', 'New campaign'), icon: 'plus', act: 'dialog', arg: 'campaign', variant: 'primary', disabled: live.busy !== null })] : [])]),
    h('section', { class: 'grid3', 'aria-label': t(state, 'ملخص الحملات', 'Campaign summary') }, [
      metric(t(state, 'الحملات', 'Campaigns'), formatNumber(campaigns.length, state.lang), t(state, 'كل الحالات', 'all states')),
      metric(t(state, 'الجمهور المثبّت', 'Frozen audience'), formatNumber(totals.total, state.lang), t(state, 'لا يتغير بعد المراجعة', 'fixed after review')),
      metric(t(state, 'مؤهل للإرسال', 'Eligible'), formatNumber(totals.eligible, state.lang), t(state, 'موافقة تسويقية فعالة', 'active marketing consent')),
      metric(t(state, 'مستبعد', 'Excluded'), formatNumber(totals.excluded, state.lang), t(state, 'Opt-out أو بلا موافقة', 'opt-out or no consent')),
    ]),
    notice('info', 'shield', t(state,
      'الإطلاق لا يرسل تلقائيًا إلى نتيجة مجهولة، ولا يضيف أشخاصًا بعد تثبيت الجمهور. القناة يجب أن تكون سليمة قبل التحقق والإطلاق.',
      'Unknown outcomes are never retried automatically, and nobody is added after the audience freezes. The channel must be healthy before validation and launch.')),
    ...body,
    campaignLedger(state),
  ]);
}

const CAMPAIGN_LABELS: Readonly<Record<CampaignState, { ar: string; en: string }>> = {
  draft: { ar: 'مسودة', en: 'Draft' }, validating: { ar: 'قيد التحقق', en: 'Validating' },
  ready: { ar: 'جاهزة', en: 'Ready' }, scheduled: { ar: 'مجدولة', en: 'Scheduled' },
  running: { ar: 'قيد التنفيذ', en: 'Running' }, pausing: { ar: 'جارٍ الإيقاف', en: 'Pausing' },
  paused: { ar: 'متوقفة', en: 'Paused' }, dispatch_completed: { ar: 'اكتمل الإرسال', en: 'Completed' },
  cancelling: { ar: 'جارٍ الإلغاء', en: 'Cancelling' }, cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  failed: { ar: 'فشلت', en: 'Failed' },
};

function campaignCard(state: AppState, campaign: Campaign, mayDraft: boolean, mayApprove: boolean, mayControl: boolean): HTMLElement {
  const actions: HTMLElement[] = [];
  if (mayDraft) actions.push(button({ label: t(state, 'إنشاء نسخة', 'Clone'), act: 'live-campaign-clone', arg: `${campaign.id}:${campaign.name}`, small: true, disabled: state.live.busy !== null }));
  if (mayDraft && (campaign.state === 'draft' || campaign.state === 'ready')) actions.push(button({ label: t(state, 'تعديل', 'Edit'), act: 'dialog', arg: `campaign-edit:${campaign.id}`, small: true, disabled: state.live.busy !== null }));
  if (mayDraft && (campaign.state === 'draft' || campaign.state === 'ready')) actions.push(button({ label: t(state, 'إرسال اختبار', 'Test send'), act: 'dialog', arg: `campaign-test-send:${campaign.id}`, small: true, disabled: state.live.busy !== null }));
  if (campaign.state === 'draft' && mayDraft) actions.push(button({ label: t(state, 'تثبيت الجمهور', 'Freeze audience'), act: 'live-campaign-validate', arg: campaign.id, small: true, variant: 'primary', disabled: state.live.busy !== null }));
  if (campaign.state === 'ready' && !campaign.approved && mayApprove) actions.push(button({ label: t(state, 'اعتماد النسخة', 'Approve revision'), act: 'live-campaign-approve', arg: campaign.id, small: true, variant: 'primary', disabled: state.live.busy !== null }));
  if (campaign.state === 'ready' && campaign.approved && mayDraft) actions.push(button({ label: t(state, 'إطلاق الآن', 'Launch now'), act: 'live-campaign-launch', arg: campaign.id, small: true, variant: 'primary', disabled: state.live.busy !== null }));
  if (campaign.state === 'running') actions.push(button({ label: t(state, 'إيقاف مؤقت', 'Pause'), act: 'live-campaign-control', arg: `${campaign.id}:pause`, small: true, disabled: state.live.busy !== null }));
  if (campaign.state === 'paused') actions.push(button({ label: t(state, 'استئناف', 'Resume'), act: 'live-campaign-control', arg: `${campaign.id}:resume`, small: true, variant: 'primary', disabled: state.live.busy !== null }));
  if (mayControl && (campaign.state === 'dispatch_completed' || campaign.state === 'failed')) actions.push(button({ label: t(state, 'إعادة الفاشل فقط', 'Retry failed only'), act: 'live-campaign-retry', arg: campaign.id, small: true, disabled: state.live.busy !== null }));
  if (['scheduled','running','paused'].includes(campaign.state)) actions.push(button({ label: t(state, 'إلغاء الباقي', 'Cancel remaining'), act: 'live-campaign-control', arg: `${campaign.id}:cancel`, small: true, disabled: state.live.busy !== null }));
  if (campaign.execution !== null) actions.push(button({ label: t(state, 'سجل المستلمين', 'Recipient ledger'), act: 'live-campaign-ledger', arg: campaign.id, small: true, disabled: state.live.busy !== null }));
  const audience = campaign.audience;
  const cardElement = card(campaign.name, [
    pill(t(state, CAMPAIGN_LABELS[campaign.state].ar, CAMPAIGN_LABELS[campaign.state].en), campaign.state === 'running' ? 'accent' : campaign.state === 'failed' ? 'danger' : 'neutral'),
    campaign.approved ? pill(t(state, 'معتمدة', 'Approved'), 'success', 'check') : pill(t(state, 'غير معتمدة', 'Not approved'), 'warning', 'alert'),
  ], [
    h('p', { class: 'broadcast-card__objective' }, [campaign.objective ?? t(state, 'بلا هدف مكتوب', 'No objective recorded')]),
    h('dl', { class: 'broadcast-card__details' }, [
      h('div', {}, [h('dt', {}, [t(state, 'المراجعة', 'Revision')]), h('dd', {}, [isolated(String(campaign.revision), true)])]),
      h('div', {}, [h('dt', {}, [t(state, 'الجمهور', 'Audience')]), h('dd', {}, [audience === null ? t(state, 'لم يُثبّت', 'Not frozen') : `${formatNumber(audience.eligible, state.lang)} / ${formatNumber(audience.total, state.lang)}`])]),
      h('div', {}, [h('dt', {}, [t(state, 'التنفيذ', 'Execution')]), h('dd', {}, [campaign.execution?.state ?? t(state, 'لم يبدأ', 'Not started')])]),
    ]),
    h('div', { class: 'workspace__actions broadcast-card__actions', style: 'margin-inline-start:0' }, actions),
  ]);
  cardElement.classList.add('broadcast-card');
  return cardElement;
}

function campaignLedger(state: AppState): HTMLElement | null {
  const resource = state.live.campaignRecipients;
  if (state.live.selectedCampaignId === null) return null;
  if (resource.status === 'idle' || resource.status === 'loading') return h('section', { class: 'card', 'aria-busy': 'true' }, [t(state, 'جارٍ تحميل السجل…', 'Loading ledger…')]);
  if (resource.status === 'error') return notice('warning', 'alert', `${resource.error.message}${resource.error.requestId === null ? '' : ` · ${resource.error.requestId}`}`);
  return h('section', { class: 'card' }, [
    h('div', { class: 'card__header' }, [h('h2', { class: 'card__title' }, [t(state, 'سجل المستلمين', 'Recipient ledger')]), pill(formatNumber(resource.value.length, state.lang), 'neutral')]),
    resource.value.length === 0 ? stateBox({ kind: 'empty', iconName: 'users', title: t(state, 'لا يوجد مستلمون', 'No recipients'), body: t(state, 'الجمهور المثبت لم يحتوِ مستلمين مؤهلين.', 'The frozen audience contained no eligible recipients.') }) :
      h('div', { class: 'tablewrap' }, [h('table', { class: 'datatable' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, [t(state, 'الاسم', 'Name')]), h('th', {}, [t(state, 'الحالة', 'State')]), h('th', {}, [t(state, 'التكلفة المقدرة', 'Estimated cost')])])]),
        h('tbody', {}, resource.value.map((row) => h('tr', {}, [h('td', {}, [row.display_name]), h('td', {}, [pill(row.state, row.state === 'failed' ? 'danger' : 'neutral')]), h('td', {}, [isolated(row.estimated_amount_minor === null ? '—' : `${row.estimated_amount_minor} ${row.currency ?? ''}`, true)])]))),
      ])]),
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
  const resource = state.live.campaignReport;
  const tenantId = state.live.session.status === 'signed_in' ? state.live.session.tenantId : null;
  if (state.live.session.status === 'unknown' || (tenantId !== null && (resource.status === 'idle' || resource.status === 'loading'))) {
    return h('div', { class: 'workspace workspace--analytics', tabindex: '0', 'data-scroll': 'screen' }, [
      intro(state, t(state, 'تقارير الحملات', 'Campaign analytics'), t(state, 'جارٍ قراءة سجل التنفيذ…', 'Reading the execution ledger…'), []),
      h('div', { class: 'skeleton', 'aria-busy': 'true' }, [h('div', { class: 'skeletonrow' }), h('div', { class: 'skeletonrow' })]),
    ]);
  }
  if (state.live.session.status === 'signed_out') {
    return reportState(state, 'denied', t(state, 'تحتاج جلسة', 'You need a session'), t(state, 'سجّل الدخول لعرض تقارير الخادم.', 'Sign in to view server reports.'));
  }
  if (tenantId === null) {
    return reportState(state, 'info', t(state, 'لا توجد عضوية نشطة', 'No active membership'), t(state, 'اختر شركة لعرض تقاريرها.', 'Choose a company to view its reports.'));
  }
  if (resource.status === 'error') {
    return h('div', { class: 'workspace workspace--analytics', tabindex: '0', 'data-scroll': 'screen' }, [
      intro(state, t(state, 'تقارير الحملات', 'Campaign analytics'), t(state, 'نتائج فعلية من سجل التنفيذ.', 'Live results from the execution ledger.'), []),
      stateBox({ kind: 'denied', iconName: 'alert', title: resource.error.message,
        body: resource.error.requestId === null ? t(state, 'تعذر الاتصال بالخادم.', 'The server could not be reached.') : `Request ID: ${resource.error.requestId}`,
        actionLabel: t(state, 'إعادة التحميل', 'Reload'), act: 'live-report-reload' }),
    ]);
  }
  const report = (resource as Extract<typeof resource, { readonly status: 'ready' }>).value;
  const denominator = report.milestones.denominator;
  const freshness = dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.fresh_through));
  const ratio = (value: number): string => denominator === 0 ? '—' : numberFormat(state.lang, { style: 'percent', maximumFractionDigits: 1 }).format(value / denominator);
  return h('div', { class: 'workspace workspace--analytics', tabindex: '0', 'data-scroll': 'screen', 'data-report-ready': 'true' }, [
    intro(
      state,
      t(state, 'تقارير الحملات', 'Campaign analytics'),
      t(
        state,
        'كل رقم هنا يحمل مقامه المنشور ووقت تحديثه. لا نسب بلا مقام، ولا إيصالات مفترضة.',
        'Every number carries its published denominator and freshness. No ratios without a denominator, and no assumed receipts.',
      ),
      [
        button({ label: t(state, 'تحديث', 'Reload'), icon: 'refresh', act: 'live-report-reload' }),
      ],
    ),
    notice(
      'info',
      'info',
      t(
        state,
        `آخر دليل تشغيلي داخل التقرير: ${freshness}. الحالات الحالية منفصلة، ومراحل الوصول تراكمية.`,
        `Latest execution evidence in this report: ${freshness}. Current states are disjoint; reached milestones are cumulative.`,
      ),
    ),
    h('div', { class: 'grid3' }, [
      metric(
        t(state, 'قُبلت للإرسال', 'Accepted'), formatNumber(report.milestones.accepted, state.lang),
        `${ratio(report.milestones.accepted)} · ${t(state, 'من', 'of')} ${formatNumber(denominator, state.lang)}`,
      ),
      metric(
        t(state, 'تم التسليم', 'Delivered'), formatNumber(report.milestones.delivered, state.lang),
        `${ratio(report.milestones.delivered)} · ${t(state, 'من', 'of')} ${formatNumber(denominator, state.lang)}`,
      ),
      metric(
        t(state, 'تمت القراءة', 'Read'), formatNumber(report.milestones.read, state.lang),
        `${ratio(report.milestones.read)} · ${t(state, 'من', 'of')} ${formatNumber(denominator, state.lang)}`,
      ),
      metric(
        t(state, 'نتيجة غير معلومة', 'Outcome unknown'), formatNumber(report.current.outcome_unknown, state.lang),
        t(state, 'لا تُعاد تلقائيًا', 'never automatically retried'),
      ),
    ]),
    card(
      t(state, 'الأداء حسب القناة', 'Performance by channel'),
      [pill(t(state, 'دليل حي', 'Live evidence'), 'neutral', 'clock')],
      [
        h(
          'div',
          { class: 'bars' },
          report.channels.map((channel) => barRow(channelLabel(state, channel.kind),
            channel.accepted / Math.max(channel.denominator, 1),
            `${formatNumber(channel.accepted, state.lang)} / ${formatNumber(channel.denominator, state.lang)}`)),
        ),
      ],
    ),
    card(
      t(state, 'الحالات الحالية', 'Current states'),
      [],
      [
        h(
          'div',
          { class: 'bars' },
          (['planned','queued','in_flight','accepted','delivered','read','failed','skipped','cancelled','outcome_unknown'] as const)
            .filter((key) => report.current[key] > 0)
            .map((key) => barRow(reportStateLabel(state, key), report.current[key] / Math.max(report.current.denominator, 1), formatNumber(report.current[key], state.lang), key === 'failed' || key === 'outcome_unknown')),
        ),
      ],
    ),
    card(
      t(state, 'الإيصالات حسب القناة', 'Receipts by channel'),
      [],
      [
        h('dl', { class: 'attrgrid' }, report.channels.flatMap((channel) => [
          h('dt', {}, [channelLabel(state, channel.kind)]),
          h('dd', {}, [channel.read_receipts
            ? pill(`${formatNumber(channel.read, state.lang)} / ${formatNumber(channel.denominator, state.lang)}`, 'success', 'check')
            : pill(t(state, 'غير متاح', 'Not available'), 'neutral', 'info')]),
        ])),
      ],
    ),
    card(t(state, 'التكلفة', 'Cost'), [pill(t(state, 'مقدّرة وفعلية منفصلتان', 'Estimated and reconciled separated'), 'neutral')], [
      report.costs.length === 0 ? notice('plain', 'info', t(state, 'لا توجد تكلفة بعد.', 'No cost evidence yet.')) :
        h('div', { class: 'tablewrap' }, [h('table', { class: 'datatable' }, [
          h('thead', {}, [h('tr', {}, [h('th', {}, [t(state, 'العملة', 'Currency')]), h('th', {}, [t(state, 'مقدّرة', 'Estimated')]), h('th', {}, [t(state, 'مُلتزم بها', 'Committed')]), h('th', {}, [t(state, 'مُصالَحة', 'Reconciled')])])]),
          h('tbody', {}, report.costs.map((cost) => h('tr', {}, [h('td', {}, [isolated(cost.currency)]), h('td', {}, [isolated(cost.estimated_amount_minor, true)]), h('td', {}, [isolated(cost.committed_amount_minor, true)]), h('td', {}, [isolated(cost.reconciled_amount_minor, true)])]))),
        ])]),
    ]),
    card(t(state, 'أخطاء التنفيذ', 'Execution errors'), [], [
      report.errors.length === 0 ? notice('plain', 'check', t(state, 'لا توجد أخطاء مسجلة.', 'No errors recorded.')) :
        h('div', { class: 'bars' }, report.errors.map((error) => barRow(error.code, error.count / Math.max(report.current.denominator, 1), formatNumber(error.count, state.lang), true))),
    ]),
  ]);
}

function reportState(state: AppState, kind: 'denied' | 'info', title: string, body: string): HTMLElement {
  return h('div', { class: 'workspace workspace--analytics', tabindex: '0', 'data-scroll': 'screen' }, [
    stateBox({ kind, iconName: kind === 'denied' ? 'lock' : 'info', title, body }),
  ]);
}

function channelLabel(state: AppState, kind: string): string {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    whatsapp: ['واتساب', 'WhatsApp'], messenger: ['ماسنجر', 'Messenger'], instagram: ['إنستجرام', 'Instagram'],
    web_chat: ['محادثة الموقع', 'Website chat'], custom: ['قناة مخصصة', 'Custom channel'],
  };
  const label = labels[kind];
  return label === undefined ? kind : label[state.lang === 'ar' ? 0 : 1];
}

function reportStateLabel(state: AppState, key: 'planned' | 'queued' | 'in_flight' | 'accepted' | 'delivered' | 'read' | 'failed' | 'skipped' | 'cancelled' | 'outcome_unknown'): string {
  const labels: Readonly<Record<typeof key, readonly [string, string]>> = {
    planned: ['مخطط', 'Planned'], queued: ['في الطابور', 'Queued'], in_flight: ['قيد الإرسال', 'In flight'],
    accepted: ['مقبول', 'Accepted'], delivered: ['تم التسليم', 'Delivered'], read: ['تمت القراءة', 'Read'],
    failed: ['فشل', 'Failed'], skipped: ['مستبعد', 'Skipped'], cancelled: ['ملغي', 'Cancelled'],
    outcome_unknown: ['نتيجة غير معلومة', 'Outcome unknown'],
  };
  return labels[key][state.lang === 'ar' ? 0 : 1];
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
