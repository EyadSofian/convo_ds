import type { Campaign, CampaignRecipient } from '../api/campaigns.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber, relativeTime } from '../format.js';
import { icon } from '../icons.js';
import { hasPermission } from '../live/ability.js';
import { rowsOf } from '../live/store.js';
import type { LiveState } from '../live/store.js';
import type { AppState } from '../state.js';
import { CAMPAIGN_STATES, CHANNEL_NAMES, ERROR_CODES, phrase, RECIPIENT_STATES, t } from './copy.js';
import {
  badge,
  button,
  emptyState,
  errorState,
  inlineError,
  isolated,
  kpi,
  page,
  panel,
  refreshButton,
  skeleton,
  toolbar,
} from './parts.js';
import type { Tone } from './parts.js';

/**
 * Campaigns, backed entirely by the API.
 *
 * The screen follows the lifecycle the server enforces — draft, frozen
 * audience, approval of that exact revision, launch, then one ledger row per
 * recipient — and offers each step only to a membership holding its key and
 * only from a state the server accepts it in. Every step is still refused by
 * the server on its own terms; nothing here is optimistic.
 */

const STATE_TONE: Readonly<Record<string, Tone>> = {
  draft: 'neutral',
  validating: 'accent',
  ready: 'accent',
  scheduled: 'accent',
  running: 'accent',
  pausing: 'warning',
  paused: 'warning',
  dispatch_completed: 'success',
  cancelling: 'warning',
  cancelled: 'neutral',
  failed: 'danger',
};

const RECIPIENT_TONE: Readonly<Record<string, Tone>> = {
  accepted: 'accent',
  delivered: 'success',
  read: 'success',
  failed: 'danger',
  skipped: 'warning',
  outcome_unknown: 'unknown',
};

interface Abilities {
  readonly draft: boolean;
  readonly approve: boolean;
  readonly launch: boolean;
  readonly control: boolean;
  readonly report: boolean;
}

function abilities(live: LiveState): Abilities {
  return {
    draft: hasPermission(live, 'campaign.draft'),
    approve: hasPermission(live, 'campaign.approve'),
    launch: hasPermission(live, 'campaign.launch'),
    control: hasPermission(live, 'campaign.control'),
    report: hasPermission(live, 'report.read'),
  };
}

export function campaignStateBadge(state: AppState, value: string): HTMLElement {
  return badge(phrase(state, CAMPAIGN_STATES, value), STATE_TONE[value] ?? 'neutral', { dot: true });
}

export function renderBroadcasts(state: AppState): HTMLElement {
  const live = state.live;
  const can = abilities(live);
  return page('campaigns', toolbar(
    t(state, 'أنشئ الحملات واعتمدها وتابع نتيجة كل مستلم.', 'Create, approve and follow every recipient of your campaigns.'),
    [
      refreshButton(state, 'live-campaigns-reload', live.campaigns.status === 'loading'),
      can.draft ? button({ label: t(state, 'حملة جديدة', 'New campaign'), icon: 'plus', act: 'dialog', arg: 'campaign', variant: 'primary', small: true }) : null,
    ],
  ), body(state, live, can));
}

function body(state: AppState, live: LiveState, can: Abilities): readonly Child[] {
  if (live.campaigns.status === 'idle' || live.campaigns.status === 'loading') {
    return [skeleton(state, 4)];
  }
  if (live.campaigns.status === 'error') {
    return [errorState(state, live.campaigns.error, 'live-campaigns-reload')];
  }
  const campaigns = live.campaigns.value;
  if (campaigns.length === 0) {
    return [panel(t(state, 'الحملات', 'Campaigns'), [
      emptyState({
        icon: 'broadcasts',
        title: t(state, 'لا توجد حملات بعد', 'No campaigns yet'),
        body: can.draft
          ? t(state, 'أنشئ مسودة، ثبّت جمهورها، ثم اعتمدها وأطلقها.', 'Create a draft, freeze its audience, then approve and launch it.')
          : t(state, 'لم تُنشأ أي حملة في مساحة العمل.', 'No campaign has been created in this workspace.'),
        action: can.draft ? { label: t(state, 'حملة جديدة', 'New campaign'), act: 'dialog', arg: 'campaign', primary: true } : undefined,
      }),
    ])];
  }
  const selected = campaigns.find((campaign) => campaign.id === live.selectedCampaignId) ?? (campaigns[0] as Campaign);
  return [
    summary(state, campaigns),
    state.dialog === null ? inlineError(state, live.error) : null,
    h('div', { class: 'split' }, [
      panel(t(state, 'كل الحملات', 'All campaigns'), [campaignTable(state, campaigns, selected.id)], { flush: true, extraClass: 'split__list' }),
      campaignDetail(state, live, selected, can),
    ]),
  ];
}

function summary(state: AppState, campaigns: readonly Campaign[]): HTMLElement {
  const count = (predicate: (campaign: Campaign) => boolean): string => formatNumber(campaigns.filter(predicate).length, state.lang);
  return h('section', { class: 'kpis kpis--4', 'aria-label': t(state, 'ملخص الحملات', 'Campaign summary') }, [
    kpi(t(state, 'كل الحملات', 'Campaigns'), formatNumber(campaigns.length, state.lang)),
    kpi(t(state, 'بانتظار الاعتماد', 'Awaiting approval'), count((campaign) => campaign.state === 'ready' && !campaign.approved)),
    kpi(t(state, 'مجدولة', 'Scheduled'), count((campaign) => campaign.state === 'scheduled')),
    kpi(t(state, 'قيد الإرسال', 'Sending now'), count((campaign) => campaign.state === 'running' || campaign.state === 'pausing')),
  ]);
}

function campaignTable(state: AppState, campaigns: readonly Campaign[], selectedId: string): HTMLElement {
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table table--interactive' }, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { scope: 'col' }, [t(state, 'الحملة', 'Campaign')]),
          h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'المؤهلون', 'Eligible')]),
          h('th', { scope: 'col' }, [t(state, 'آخر تحديث', 'Updated')]),
        ]),
      ]),
      h('tbody', {}, campaigns.map((campaign) =>
        h('tr', { 'aria-current': campaign.id === selectedId ? 'true' : undefined, 'data-campaign': campaign.id }, [
          h('td', {}, [
            h('button', { type: 'button', class: 'table__link', 'data-act': 'live-campaign-open', 'data-arg': campaign.id }, [campaign.name]),
            h('span', { class: 'table__sub' }, [campaign.objective ?? t(state, 'بلا هدف مكتوب', 'No objective')]),
          ]),
          h('td', {}, [campaignStateBadge(state, campaign.state)]),
          h('td', { class: 'num' }, [
            campaign.audience === null
              ? h('span', { class: 'muted' }, [t(state, 'غير مثبّت', 'Not frozen')])
              : isolated(formatNumber(campaign.audience.eligible, state.lang)),
          ]),
          h('td', {}, [relativeTime(campaign.updated_at, state.clock, state.lang)]),
        ]),
      )),
    ]),
  ]);
}

/* ----------------------------------------------------------------- detail -- */

function campaignDetail(state: AppState, live: LiveState, campaign: Campaign, can: Abilities): HTMLElement {
  const connection = rowsOf(live.connections).find((entry) => entry.id === campaign.connection_id);
  const busyPrefix = (name: string): boolean => live.busy === `campaign-${name}:${campaign.id}`;
  return h('section', { class: 'panel campaign-detail', 'aria-labelledby': 'campaign-detail-title', 'data-campaign-detail': campaign.id }, [
    h('header', { class: 'panel__header' }, [
      h('div', { class: 'panel__titles' }, [
        h('h2', { class: 'panel__title', id: 'campaign-detail-title' }, [campaign.name]),
        h('div', { class: 'badge-row' }, [
          campaignStateBadge(state, campaign.state),
          campaign.approved
            ? badge(t(state, 'معتمدة', 'Approved'), 'success', { icon: 'check' })
            : badge(t(state, 'غير معتمدة', 'Not approved'), 'warning'),
          badge(t(state, `النسخة ${String(campaign.revision)}`, `Revision ${String(campaign.revision)}`), 'neutral'),
        ]),
      ]),
    ]),
    h('div', { class: 'panel__body campaign-detail__body' }, [
      steps(state, campaign),
      h('div', { class: 'campaign-detail__grid' }, [
        audienceSummary(state, campaign),
        h('dl', { class: 'attrgrid' }, [
          h('dt', {}, [t(state, 'القناة', 'Channel')]),
          h('dd', {}, [connection === undefined ? '—' : `${connection.display_name} · ${phrase(state, CHANNEL_NAMES, connection.kind)}`]),
          h('dt', {}, [t(state, 'المنطقة الزمنية', 'Time zone')]),
          h('dd', {}, [isolated(campaign.timezone)]),
          h('dt', {}, [t(state, 'موعد الإطلاق', 'Launch')]),
          h('dd', {}, [
            campaign.execution === null
              ? t(state, 'لم تُطلق', 'Not launched')
              : campaign.execution.scheduled_for === null
                ? phrase(state, CAMPAIGN_STATES, campaign.execution.state)
                : dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(campaign.execution.scheduled_for)),
          ]),
          h('dt', {}, [t(state, 'آخر تحديث', 'Updated')]),
          h('dd', {}, [relativeTime(campaign.updated_at, state.clock, state.lang)]),
        ]),
      ]),
      actions(state, live, campaign, can, busyPrefix),
      ledger(state, live, campaign),
    ]),
  ]);
}

/**
 * Where the campaign is in the lifecycle, as the server's record shows it.
 */
function steps(state: AppState, campaign: Campaign): HTMLElement {
  const launched = campaign.execution !== null;
  const done = campaign.state === 'dispatch_completed';
  const list: readonly { readonly label: string; readonly complete: boolean }[] = [
    { label: t(state, 'مسودة', 'Draft'), complete: true },
    { label: t(state, 'تثبيت الجمهور', 'Audience frozen'), complete: campaign.audience !== null },
    { label: t(state, 'الاعتماد', 'Approved'), complete: campaign.approved },
    { label: t(state, 'الإطلاق', 'Launched'), complete: launched },
    { label: t(state, 'اكتمال الإرسال', 'Sent'), complete: done },
  ];
  const current = list.findIndex((step) => !step.complete);
  return h('ol', { class: 'steps', 'aria-label': t(state, 'مراحل الحملة', 'Campaign progress') }, list.map((step, index) =>
    h('li', { class: step.complete ? 'steps__item steps__item--done' : index === current ? 'steps__item steps__item--current' : 'steps__item', 'aria-current': index === current ? 'step' : undefined }, [
      h('span', { class: 'steps__mark', 'aria-hidden': 'true' }, [step.complete ? icon('check', 14) : String(index + 1)]),
      h('span', { class: 'steps__label' }, [step.label]),
    ]),
  ));
}

function audienceSummary(state: AppState, campaign: Campaign): HTMLElement {
  const audience = campaign.audience;
  if (audience === null) {
    return h('div', { class: 'validation validation--pending' }, [
      h('p', { class: 'validation__title' }, [t(state, 'الجمهور غير مثبّت', 'Audience not frozen')]),
      h('p', { class: 'validation__body' }, [t(state, 'ثبّت الجمهور لمعرفة عدد المؤهلين والمستبعدين قبل الاعتماد.', 'Freeze the audience to see who is eligible and excluded before approval.')]),
    ]);
  }
  return h('div', { class: 'validation' }, [
    h('p', { class: 'validation__title' }, [t(state, 'ملخص التحقق', 'Validation summary')]),
    h('dl', { class: 'validation__figures' }, [
      h('div', {}, [h('dt', {}, [t(state, 'الإجمالي', 'Total')]), h('dd', {}, [formatNumber(audience.total, state.lang)])]),
      h('div', {}, [h('dt', {}, [t(state, 'مؤهلون', 'Eligible')]), h('dd', {}, [formatNumber(audience.eligible, state.lang)])]),
      h('div', {}, [h('dt', {}, [t(state, 'مستبعدون', 'Excluded')]), h('dd', {}, [formatNumber(audience.excluded, state.lang)])]),
    ]),
    h('p', { class: 'validation__body' }, [t(state, 'المستبعدون: انسحاب أو لا توجد موافقة تسويقية.', 'Excluded: opted out or no marketing consent.')]),
  ]);
}

function actions(
  state: AppState,
  live: LiveState,
  campaign: Campaign,
  can: Abilities,
  busy: (name: string) => boolean,
): HTMLElement {
  const editable = campaign.state === 'draft' || campaign.state === 'ready';
  const primary: HTMLElement[] = [];
  const secondary: HTMLElement[] = [];
  if (can.draft && campaign.state === 'draft') {
    primary.push(button({ label: t(state, 'تثبيت الجمهور', 'Freeze audience'), icon: 'users', act: 'live-campaign-validate', arg: campaign.id, small: true, variant: 'primary', busy: busy('validate') }));
  }
  if (can.approve && campaign.state === 'ready' && !campaign.approved) {
    primary.push(button({ label: t(state, 'اعتماد النسخة', 'Approve revision'), icon: 'check', act: 'live-campaign-approve', arg: campaign.id, small: true, variant: 'primary', busy: busy('approve') }));
  }
  if (can.launch && campaign.state === 'ready' && campaign.approved) {
    primary.push(button({ label: t(state, 'إطلاق الآن', 'Launch now'), icon: 'send', act: 'live-campaign-launch', arg: campaign.id, small: true, variant: 'primary', busy: busy('launch') }));
    primary.push(button({ label: t(state, 'جدولة', 'Schedule'), icon: 'calendar', act: 'dialog', arg: `campaign-schedule:${campaign.id}`, small: true }));
  }
  if (can.control && campaign.state === 'running') {
    primary.push(button({ label: t(state, 'إيقاف مؤقت', 'Pause'), icon: 'pause', act: 'live-campaign-control', arg: `${campaign.id}:pause`, small: true, busy: busy('pause') }));
  }
  if (can.control && campaign.state === 'paused') {
    primary.push(button({ label: t(state, 'استئناف', 'Resume'), icon: 'play', act: 'live-campaign-control', arg: `${campaign.id}:resume`, small: true, variant: 'primary', busy: busy('resume') }));
  }
  if (can.control && ['scheduled', 'running', 'paused'].includes(campaign.state)) {
    primary.push(button({ label: t(state, 'إلغاء المتبقي', 'Cancel remaining'), icon: 'stop', act: 'live-campaign-control', arg: `${campaign.id}:cancel`, small: true, variant: 'danger', busy: busy('cancel') }));
  }
  if (can.control && (campaign.state === 'dispatch_completed' || campaign.state === 'failed')) {
    primary.push(button({ label: t(state, 'إعادة الفاشل فقط', 'Retry failed only'), icon: 'refresh', act: 'live-campaign-retry', arg: campaign.id, small: true, busy: live.busy === `campaign-retry:${campaign.id}` }));
  }
  if (can.draft && editable) {
    secondary.push(button({ label: t(state, 'تعديل', 'Edit'), icon: 'edit', act: 'dialog', arg: `campaign-edit:${campaign.id}`, small: true, variant: 'ghost' }));
    secondary.push(button({ label: t(state, 'إرسال تجريبي', 'Test send'), icon: 'flask', act: 'dialog', arg: `campaign-test-send:${campaign.id}`, small: true, variant: 'ghost' }));
  }
  if (can.draft) {
    secondary.push(button({ label: t(state, 'نسخ', 'Clone'), icon: 'copy', act: 'live-campaign-clone', arg: `${campaign.id}:${campaign.name}`, small: true, variant: 'ghost', busy: busy('clone') }));
  }
  if (can.report && campaign.execution !== null) {
    secondary.push(button({ label: t(state, 'عرض التقرير', 'View report'), icon: 'analytics', act: 'campaign-report', arg: campaign.id, small: true, variant: 'ghost' }));
  }
  return h('div', { class: 'action-bar' }, [
    h('div', { class: 'action-bar__group' }, primary),
    h('div', { class: 'action-bar__group' }, secondary),
  ]);
}

function ledger(state: AppState, live: LiveState, campaign: Campaign): Child {
  if (campaign.execution === null) {
    return null;
  }
  const heading = h('h3', { class: 'subsection-title', id: 'ledger-title' }, [t(state, 'سجل المستلمين', 'Recipients')]);
  if (live.selectedCampaignId !== campaign.id) {
    return h('section', { class: 'ledger', 'aria-labelledby': 'ledger-title' }, [
      heading,
      button({ label: t(state, 'عرض المستلمين', 'Show recipients'), act: 'live-campaign-open', arg: campaign.id, small: true }),
    ]);
  }
  const resource = live.campaignRecipients;
  return h('section', { class: 'ledger', 'aria-labelledby': 'ledger-title' }, [
    heading,
    resource.status === 'idle' || resource.status === 'loading'
      ? skeleton(state, 3)
      : resource.status === 'error'
        ? errorState(state, resource.error, 'live-campaigns-reload')
        : resource.value.length === 0
          ? emptyState({ icon: 'users', title: t(state, 'لا يوجد مستلمون', 'No recipients'), body: t(state, 'لم يتضمن الجمهور المثبّت أي مستلم مؤهل.', 'The frozen audience had no eligible recipients.') })
          : recipientTable(state, resource.value),
  ]);
}

function recipientTable(state: AppState, rows: readonly CampaignRecipient[]): HTMLElement {
  return h('div', { class: 'tablewrap' }, [
    h('table', { class: 'table' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', { scope: 'col' }, [t(state, 'المستلم', 'Recipient')]),
        h('th', { scope: 'col' }, [t(state, 'الحالة', 'Status')]),
        h('th', { scope: 'col' }, [t(state, 'السبب', 'Reason')]),
        h('th', { scope: 'col', class: 'num' }, [t(state, 'التكلفة المقدّرة', 'Estimated cost')]),
      ])]),
      h('tbody', {}, rows.map((row) => {
        const code = errorCodeOf(row.last_error);
        return h('tr', {}, [
          h('td', {}, [h('span', { class: 'table__primary' }, [isolated(row.display_name)]), h('span', { class: 'table__sub' }, [isolated(row.external_id, true)])]),
          h('td', {}, [badge(phrase(state, RECIPIENT_STATES, row.state), RECIPIENT_TONE[row.state] ?? 'neutral')]),
          h('td', {}, [code === null ? '—' : phrase(state, ERROR_CODES, code)]),
          h('td', { class: 'num' }, [row.estimated_amount_minor === null ? '—' : isolated(`${row.estimated_amount_minor} ${row.currency ?? ''}`.trim(), true)]),
        ]);
      })),
    ]),
  ]);
}

/** The typed code inside a recipient's last error, when the ledger recorded one. */
export function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : null;
}
