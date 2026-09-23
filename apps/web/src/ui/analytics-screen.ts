import type { AssignmentReportRow, CampaignReport, CampaignReportExport, CampaignReportTrendDay, OperationalReport, ResponseReport, ResolutionReport, TimingChannelReportRow, TimingReportRow } from '../api/campaigns.js';
import type { Child } from '../dom.js';
import { h } from '../dom.js';
import { dateFormat, formatNumber, numberFormat } from '../format.js';
import { formatHash } from '../router.js';
import { icon } from '../icons.js';
import type { AppState } from '../state.js';
import { routeParamsFor } from '../state.js';
import { campaignStateBadge } from './campaigns-screen.js';
import { CHANNEL_NAMES, ERROR_CODES, phrase, RECIPIENT_STATES, t } from './copy.js';
import {
  badge,
  button,
  emptyState,
  errorState,
  inlineError,
  isolated,
  kpi,
  notice,
  page,
  panel,
  progress,
  selectControl,
  segmented,
  skeleton,
} from './parts.js';
import type { Tone } from './parts.js';

/**
 * Campaign analytics, read from the server's report.
 *
 * Every percentage names its denominator — the recipients in the executions
 * the filters selected — and the report says how fresh it is. Nothing is
 * computed from a count the API did not send: replies are not measured by the
 * report, so they are labelled as such rather than shown as zero.
 */

function percent(state: AppState, value: number, denominator: number): string {
  return denominator === 0
    ? '—'
    : numberFormat(state.lang, { style: 'percent', maximumFractionDigits: 1 }).format(value / denominator);
}

function stamp(state: AppState, iso: string): string {
  return dateFormat(state.lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso));
}

export function renderAnalytics(state: AppState): HTMLElement {
  if (state.analyticsView === 'assignments') return renderAssignments(state);
  if (state.analyticsView === 'responses') return renderResponses(state);
  if (state.analyticsView === 'resolutions') return renderResolutions(state);
  if (state.analyticsView === 'teams') return renderTeams(state);
  if (state.analyticsView === 'agents') return renderAgents(state);
  if (state.analyticsView === 'channels') return renderChannels(state);
  if (state.analyticsView === 'overview') return renderOperations(state);
  const resource = state.live.campaignReport;
  const report = resource.status === 'ready' ? resource.value : null;
  return page('analytics', analyticsHeader(state, filterBar(state, report)), [
    resource.status === 'idle' || resource.status === 'loading'
      ? skeleton(state, 4)
      : resource.status === 'error'
        ? errorState(state, resource.error, 'live-report-reload')
        : null,
    ...(report === null ? [] : reportBody(state, report)),
  ]);
}

function analyticsHeader(state: AppState, filters: HTMLElement): HTMLElement {
  return h('div', { class: 'stack stack--sm' }, [
    h('div', { class: 'report-nav', role: 'region', 'aria-label': t(state, 'التنقل بين التقارير', 'Report navigation'), tabindex: '0' }, [segmented([
      { value: 'overview', label: t(state, 'نظرة عامة', 'Overview') },
      { value: 'agents', label: t(state, 'الوكلاء', 'Agents') },
      { value: 'teams', label: t(state, 'الفرق', 'Teams') },
      { value: 'responses', label: t(state, 'الاستجابات', 'Responses') },
      { value: 'resolutions', label: t(state, 'الحلول', 'Resolutions') },
      { value: 'assignments', label: t(state, 'الإسنادات', 'Assignments') },
      { value: 'channels', label: t(state, 'القنوات', 'Channels') },
      { value: 'campaigns', label: t(state, 'الحملات', 'Campaigns') },
    ], state.analyticsView, 'analytics-view', t(state, 'نوع التقرير', 'Report type'))]),
    filters,
  ]);
}

function renderResponses(state: AppState): HTMLElement {
  const resource = state.live.responseReport;
  const report = resource.status === 'ready' ? resource.value : null;
  const filters = operationsFilterBar(state, state.live.operationalReport.status === 'ready' ? state.live.operationalReport.value : null, resource.status === 'loading');
  const body: Child[] = [];
  if (resource.status === 'idle' || resource.status === 'loading') body.push(skeleton(state, 3));
  else if (resource.status === 'error') body.push(errorState(state, resource.error, 'live-report-reload'));
  if (report !== null) body.push(...responseBody(state, report));
  return page('analytics', analyticsHeader(state, filters), body);
}

function responseBody(state: AppState, report: ResponseReport): readonly Child[] {
  return [
    h('section', { class: 'kpis kpis--3', 'aria-label': t(state, 'مقاييس أول استجابة', 'First-response measures') }, [
      kpi(t(state, 'استجابات مقاسة', 'Measured responses'), formatNumber(report.measured, state.lang)),
      kpi(t(state, 'المتوسط', 'Average'), duration(state, report.averageSeconds)),
      kpi(t(state, 'الوسيط', 'Median'), duration(state, report.medianSeconds)),
    ]),
    timingBreakdown(state, t(state, 'توزيع زمن أول رد', 'First-response time buckets'), report.buckets.map((row) => ({ label: row.bucket, count: row.count }))),
    timingTable(state, t(state, 'حسب الوكيل', 'By agent'), report.byAgent, t(state, 'الوكيل', 'Agent')),
    channelTimingTable(state, t(state, 'حسب القناة', 'By channel'), report.byChannel),
  ];
}

function renderResolutions(state: AppState): HTMLElement {
  const resource = state.live.resolutionReport;
  const report = resource.status === 'ready' ? resource.value : null;
  const filters = operationsFilterBar(state, state.live.operationalReport.status === 'ready' ? state.live.operationalReport.value : null, resource.status === 'loading');
  const body: Child[] = [];
  if (resource.status === 'idle' || resource.status === 'loading') body.push(skeleton(state, 3));
  else if (resource.status === 'error') body.push(errorState(state, resource.error, 'live-report-reload'));
  if (report !== null) body.push(...resolutionBody(state, report));
  return page('analytics', analyticsHeader(state, filters), body);
}

function renderTeams(state: AppState): HTMLElement {
  const resource = state.live.teamReport;
  const filters = operationsFilterBar(state, state.live.operationalReport.status === 'ready' ? state.live.operationalReport.value : null, resource.status === 'loading');
  const rows = resource.status === 'ready' ? resource.value : [];
  return page('analytics', analyticsHeader(state, filters), [
    resource.status === 'idle' || resource.status === 'loading' ? skeleton(state, 3)
      : resource.status === 'error' ? errorState(state, resource.error, 'live-report-reload')
        : panel(t(state, 'أداء الفرق', 'Team performance'), [
          notice('plain', 'info', h('strong', {}, [t(state, 'تجميع حسب عضوية الفريق الحالية. ', 'Current team grouping. ')]), t(state, 'تُنسب النشاطات التاريخية لأعضاء كل فريق حاليًا؛ لا يدّعي التقرير معرفة عضوية الفريق وقت الحدث.', 'Historical activity is grouped by each agent’s current team membership; the report does not claim team ownership at event time.')),
          rows.length === 0 ? emptyState({ icon: 'people', title: t(state, 'لا توجد فرق ضمن النطاق', 'No teams in scope'), body: t(state, 'لا توجد فرق مرئية في نطاق التقارير الحالي.', 'No teams are visible in the current reporting scope.') })
            : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
              h('thead', {}, [h('tr', {}, [
                t(state, 'الفريق', 'Team'), t(state, 'الوكلاء النشطون', 'Active agents'), t(state, 'النشط الآن', 'Current active'),
                t(state, 'مفتوح', 'Open'), t(state, 'معلّق', 'Pending'), t(state, 'مؤجل', 'Snoozed'),
                t(state, 'تم التعامل', 'Handled'), t(state, 'رسائل بشرية', 'Human messages'), t(state, 'أول رد', 'First responses'),
                t(state, 'متوسط أول رد', 'Avg. first response'), t(state, 'وسيط أول رد', 'Median first response'), t(state, 'الحلول', 'Resolutions'), t(state, 'متوسط الحل', 'Avg. resolution'), t(state, 'وسيط الحل', 'Median resolution'),
              ].map((label) => h('th', { scope: 'col' }, [label])))]),
              h('tbody', {}, rows.map((row) => h('tr', { 'data-team-id': row.teamId }, [
                h('th', { scope: 'row' }, [isolated(row.name), h('div', { class: 'filterbar__actions' }, [
                  teamInboxLink(state, row.teamId), teamInboxLink(state, row.teamId, 'open'), teamInboxLink(state, row.teamId, 'unreplied'),
                ])]),
                ...[row.activeAgentCount,row.currentActive,row.currentOpen,row.currentPending,row.currentSnoozed,row.handledConversations,row.humanMessages,row.firstResponses].map((value) => h('td', { class: 'num' }, [formatNumber(value, state.lang)])),
                h('td', { class: 'num' }, [duration(state, row.firstResponseAverageSeconds)]),
                h('td', { class: 'num' }, [duration(state, row.firstResponseMedianSeconds)]),
                h('td', { class: 'num' }, [formatNumber(row.resolutions, state.lang)]),
                h('td', { class: 'num' }, [duration(state, row.resolutionAverageSeconds)]),
                h('td', { class: 'num' }, [duration(state, row.resolutionMedianSeconds)]),
              ]))),
            ])]),
        ], { flush: true }),
  ]);
}

function renderAgents(state: AppState): HTMLElement {
  const resource = state.live.operationalReport;
  const report = resource.status === 'ready' ? resource.value : null;
  return page('analytics', analyticsHeader(state, operationsFilterBar(state, report, resource.status === 'loading')),
    resource.status === 'idle' || resource.status === 'loading' ? [skeleton(state, 3)]
      : resource.status === 'error' ? [errorState(state, resource.error, 'live-report-reload')]
        : [agentPerformanceTable(state, resource.value), agentDetail(state, resource.value)]);
}

function agentPerformanceTable(state: AppState, report: OperationalReport): HTMLElement {
  const rows = report.agents;
  const headers = [t(state, 'الوكيل', 'Agent'),t(state, 'نشط الآن', 'Current active'),t(state, 'أُسند في الفترة', 'Assigned in period'),
    t(state, 'تم التعامل', 'Handled'),t(state, 'رسائل بشرية', 'Human messages'),t(state, 'ملاحظات', 'Notes'),t(state, 'أول رد', 'First responses'),
    t(state, 'متوسط الرد', 'Avg. response'),t(state, 'وسيط الرد', 'Median response'),t(state, 'حلول', 'Resolved'),
    t(state, 'متوسط الحل', 'Avg. resolution'),t(state, 'وسيط الحل', 'Median resolution'),t(state, 'إعادات إسناد', 'Reassignments')];
  return panel(t(state, 'أداء الوكلاء', 'Agent performance'), [rows.length === 0
    ? emptyState({ icon: 'people', title: t(state, 'لا يوجد وكلاء ضمن النطاق', 'No agents in scope'), body: t(state, 'لا توجد هويات وكلاء قابلة للتقرير ضمن صلاحياتك.', 'No reportable agent identities are available in your scope.') })
    : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
      h('thead', {}, [h('tr', {}, headers.map((label, index) => h('th', { scope: 'col', class: index === 0 ? undefined : 'num' }, [label])))]),
      h('tbody', {}, rows.map((agent) => h('tr', { 'data-agent-id': agent.membershipId }, [
        h('th', { scope: 'row' }, [h('a', { href: formatHash({ screen: 'analytics', conversationId: null, params: { ...routeParamsFor(state), view: 'agents', agent: agent.membershipId, agentFilter: agent.membershipId } }) }, [isolated(agent.name)]),
          h('div', { class: 'table__secondary', dir: 'ltr' }, [isolated(agent.email)])]),
        h('td', { class: 'num' }, [formatNumber(agent.currentAssigned, state.lang)]),h('td', { class: 'num' }, [formatNumber(agent.assignedInPeriod, state.lang)]),
        h('td', { class: 'num' }, [formatNumber(agent.handledConversations, state.lang)]),h('td', { class: 'num' }, [formatNumber(agent.humanMessages, state.lang)]),
        h('td', { class: 'num' }, [formatNumber(agent.internalNotes, state.lang)]),h('td', { class: 'num' }, [formatNumber(agent.firstResponses, state.lang)]),
        h('td', { class: 'num' }, [duration(state, agent.firstResponseAverageSeconds)]),h('td', { class: 'num' }, [duration(state, agent.firstResponseMedianSeconds)]),
        h('td', { class: 'num' }, [formatNumber(agent.resolutions, state.lang)]),h('td', { class: 'num' }, [duration(state, agent.resolutionAverageSeconds)]),
        h('td', { class: 'num' }, [duration(state, agent.resolutionMedianSeconds)]),h('td', { class: 'num' }, [formatNumber(agent.reassignments, state.lang)]),
      ]))),
    ])]),
  ], { flush: true });
}

function renderChannels(state: AppState): HTMLElement {
  const resource = state.live.operationalReport;
  const report = resource.status === 'ready' ? resource.value : null;
  return page('analytics', analyticsHeader(state, operationsFilterBar(state, report, resource.status === 'loading')),
    resource.status === 'idle' || resource.status === 'loading' ? [skeleton(state, 3)]
      : resource.status === 'error' ? [errorState(state, resource.error, 'live-report-reload')]
        : [channelActivityReport(state, resource.value)]);
}

function teamInboxLink(state: AppState, teamId: string, status?: 'open' | 'unreplied'): HTMLElement {
  const filters = [
    { key: 'team_id', operator: 'eq', value: teamId },
    ...(status === 'open' ? [{ key: 'status', operator: 'eq', value: status }] : []),
    ...(status === 'unreplied' ? [{ key: 'unreplied', operator: 'eq', value: true }] : []),
  ];
  return h('a', { class: 'btn btn--ghost btn--sm', href: formatHash({ screen: 'inbox', conversationId: null, params: { scope: 'all', filters: JSON.stringify(filters), lang: state.lang } }) }, [
    status === undefined ? t(state, 'كل الحالي', 'All current') : status === 'open' ? t(state, 'المفتوح', 'Open') : t(state, 'بلا رد', 'Unreplied'),
  ]);
}

function resolutionBody(state: AppState, report: ResolutionReport): readonly Child[] {
  return [
    h('section', { class: 'kpis kpis--4', 'aria-label': t(state, 'مقاييس الحل', 'Resolution measures') }, [
      kpi(t(state, 'حلقات محلولة', 'Resolved episodes'), formatNumber(report.resolvedEpisodes, state.lang)),
      kpi(t(state, 'المتوسط', 'Average'), duration(state, report.averageSeconds)),
      kpi(t(state, 'الوسيط', 'Median'), duration(state, report.medianSeconds)),
      kpi(t(state, 'حلقات أعيد فتحها', 'Reopened episodes'), formatNumber(report.reopenedEpisodes, state.lang)),
    ]),
    timingTable(state, t(state, 'حسب الوكيل', 'By agent'), report.byAgent, t(state, 'الوكيل', 'Agent')),
    channelTimingTable(state, t(state, 'حسب القناة', 'By channel'), report.byChannel),
    notice('plain', 'info', h('strong', {}, [t(state, 'تعريف إعادة الفتح. ', 'Reopen definition. ')]), t(state, 'تُحسب الحلقة المحلولة كإعادة فتح عندما يكون رقمها التسلسلي أكبر من 1 في المحادثة نفسها.', 'A resolved episode is counted as reopened when its sequence is greater than 1 in the same conversation.')),
  ];
}

function timingBreakdown(state: AppState, title: string, rows: readonly { readonly label: string; readonly count: number }[]): HTMLElement {
  return panel(title, [rows.length === 0
    ? emptyState({ icon: 'clock', title: t(state, 'لا توجد استجابات مقاسة', 'No measured responses'), body: t(state, 'لا توجد حلقات استجابة ضمن النطاق المحدد.', 'There are no response episodes in the selected scope.') })
    : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
      h('thead', {}, [h('tr', {}, [h('th', { scope: 'col' }, [t(state, 'المدة', 'Duration')]), h('th', { scope: 'col', class: 'num' }, [t(state, 'العدد', 'Count')])])]),
      h('tbody', {}, rows.map((row) => h('tr', {}, [h('th', { scope: 'row' }, [row.label]), h('td', { class: 'num' }, [formatNumber(row.count, state.lang)])]))),
    ])])], { flush: true });
}

function timingTable(state: AppState, title: string, rows: readonly TimingReportRow[], identityLabel: string): HTMLElement {
  return panel(title, [rows.length === 0
    ? emptyState({ icon: 'people', title: t(state, 'لا توجد بيانات', 'No data'), body: t(state, 'لا توجد قياسات ضمن نطاق التقرير.', 'There are no measurements in this report scope.') })
    : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
      h('thead', {}, [h('tr', {}, [identityLabel, t(state, 'مقاس', 'Measured'), t(state, 'المتوسط', 'Average'), t(state, 'الوسيط', 'Median')].map((label, index) => h('th', { scope: 'col', class: index === 0 ? undefined : 'num' }, [label])))]),
      h('tbody', {}, rows.map((row) => h('tr', { ...(row.membershipId === null ? {} : { 'data-agent-id': row.membershipId }) }, [
        h('th', { scope: 'row' }, [isolated(row.name)]), h('td', { class: 'num' }, [formatNumber(row.measured, state.lang)]),
        h('td', { class: 'num' }, [duration(state, row.averageSeconds)]), h('td', { class: 'num' }, [duration(state, row.medianSeconds)]),
      ]))),
    ])])], { flush: true });
}

function channelTimingTable(state: AppState, title: string, rows: readonly TimingChannelReportRow[]): HTMLElement {
  return panel(title, [rows.length === 0
    ? emptyState({ icon: 'inbox', title: t(state, 'لا توجد بيانات قنوات', 'No channel data'), body: t(state, 'لا توجد قياسات حسب القناة في هذا النطاق.', 'There are no channel measurements in this scope.') })
    : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
      h('thead', {}, [h('tr', {}, [t(state, 'القناة', 'Channel'), t(state, 'مقاس', 'Measured'), t(state, 'المتوسط', 'Average'), t(state, 'الوسيط', 'Median')].map((label, index) => h('th', { scope: 'col', class: index === 0 ? undefined : 'num' }, [label])))]),
      h('tbody', {}, rows.map((row) => h('tr', { 'data-channel': row.channel }, [
        h('th', { scope: 'row' }, [phrase(state, CHANNEL_NAMES, row.channel)]), h('td', { class: 'num' }, [formatNumber(row.measured, state.lang)]),
        h('td', { class: 'num' }, [duration(state, row.averageSeconds)]), h('td', { class: 'num' }, [duration(state, row.medianSeconds)]),
      ]))),
    ])])], { flush: true });
}

function renderAssignments(state: AppState): HTMLElement {
  const resource = state.live.assignmentReport;
  const rows = resource.status === 'ready' ? resource.value : [];
  const bar = operationsFilterBar(state, state.live.operationalReport.status === 'ready' ? state.live.operationalReport.value : null,
    resource.status === 'loading' || state.live.assignmentLoadingMore);
  const body: Child[] = [];
  if (resource.status === 'idle' || resource.status === 'loading') body.push(skeleton(state, 3));
  else if (resource.status === 'error') body.push(errorState(state, resource.error, 'live-report-reload'));
  else if (rows.length === 0) body.push(emptyState({ icon: 'people', title: t(state, 'لا توجد إسنادات في هذا النطاق', 'No assignments in this scope'), body: t(state, 'ستظهر هنا تغييرات الملكية المسجلة ضمن نطاق القراءة.', 'Ownership-changing events in your readable scope will appear here.') }));
  else body.push(assignmentTable(state, rows));
  if (resource.status === 'ready' && state.live.assignmentNextCursor !== null) {
    body.push(button({ label: t(state, 'تحميل المزيد', 'Load more'), act: 'live-assignments-more', small: true, busy: state.live.assignmentLoadingMore }));
  }
  return page('analytics', analyticsHeader(state, bar), body);
}

function assignmentTable(state: AppState, rows: readonly AssignmentReportRow[]): HTMLElement {
  const labels = [t(state, 'الوقت', 'Time'), t(state, 'المحادثة / العميل', 'Conversation / customer'), t(state, 'الإجراء', 'Action'), t(state, 'من', 'From'), t(state, 'إلى', 'To'), t(state, 'بواسطة', 'Actor')];
  return panel(t(state, 'سجل تغييرات الملكية', 'Ownership changes'), [h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
    h('thead', {}, [h('tr', {}, labels.map((label) => h('th', { scope: 'col' }, [label])))]),
    h('tbody', {}, rows.map((row) => h('tr', { 'data-assignment-id': row.id }, [
      h('td', { dir: 'ltr' }, [stamp(state, row.timestamp)]),
      h('td', {}, [button({ label: row.customer ?? t(state, 'فتح المحادثة', 'Open conversation'), act: 'live-inbox-open', arg: row.conversationId, small: true, variant: 'ghost' })]),
      h('td', {}, [assignmentActionLabel(state, row.action)]),
      h('td', {}, [row.previousAssignee?.displayName ?? t(state, 'غير معيّن', 'Unassigned')]),
      h('td', {}, [row.assignedTo.displayName]),
      h('td', {}, [row.actor?.displayName ?? t(state, 'النظام', 'System')]),
    ]))),
  ])])], { flush: true });
}

function assignmentActionLabel(state: AppState, action: AssignmentReportRow['action']): string {
  if (action === 'claim') return t(state, 'استلام', 'Claim');
  if (action === 'handoff') return t(state, 'تسليم ملكية', 'Handoff');
  return t(state, 'إسناد', 'Assign');
}

function renderOperations(state: AppState): HTMLElement {
  const resource = state.live.operationalReport;
  const report = resource.status === 'ready' ? resource.value : null;
  const busy = resource.status === 'loading';
  const filterBar = operationsFilterBar(state, report, busy);
  // Focused Agent and Channel routes have their own renderers above; this
  // function is reached only for Overview, so do not keep unreachable view
  // selection fallbacks here.
  const reportBody = report === null ? [] : operationsBody(state, report);
  return page('analytics', analyticsHeader(state, filterBar), [
    resource.status === 'idle' || resource.status === 'loading'
      ? skeleton(state, 4)
      : resource.status === 'error'
        ? errorState(state, resource.error, 'live-report-reload')
        : null,
    ...reportBody,
  ]);
}

function operationsFilterBar(state: AppState, report: OperationalReport | null, busy: boolean): HTMLElement {
  const filters = state.analyticsFilters;
  const teams = state.live.teams.status === 'ready' ? state.live.teams.value.filter((team) => !team.archived) : [];
  const connections = state.live.connections.status === 'ready' ? state.live.connections.value : [];
  const labelSource = state.live.workspaceLabels.status === 'ready' ? state.live.workspaceLabels.value : state.live.labels.status === 'ready' ? state.live.labels.value : [];
  const labels = labelSource.filter((label) => label.state === 'active');
  const campaigns = state.live.campaigns.status === 'ready' ? state.live.campaigns.value : state.live.reportCampaigns;
  const selectedTenant = state.live.session.status === 'signed_in' ? state.live.session.tenantId : null;
  const agents = report?.agentOptions ?? (state.live.operationalAgentOptions?.tenantId === selectedTenant
    ? state.live.operationalAgentOptions.agents
    : report?.agents ?? (state.live.supervisorAgents.status === 'ready' ? state.live.supervisorAgents.value : []));
  const options = <T extends { readonly id: string; readonly name: string }>(items: readonly T[], all: string) => [
    { value: '', label: all }, ...items.map((item) => ({ value: item.id, label: item.name })),
  ];
  const activeChips: HTMLElement[] = [];
  const chip = (id: keyof typeof filters, value: string, label: string): void => {
    if (value === '') return;
    activeChips.push(button({ label: `${label} ×`, act: 'live-report-filter', arg: `${id}:`, small: true, variant: 'ghost' }));
  };
  chip('agentId', filters.agentId, agents.find((agent) => agent.membershipId === filters.agentId)?.name ?? t(state, 'الوكيل المحدد', 'Selected agent'));
  chip('teamId', filters.teamId, teams.find((team) => team.id === filters.teamId)?.name ?? t(state, 'الفريق المحدد', 'Selected team'));
  chip('channel', filters.channel, phrase(state, CHANNEL_NAMES, filters.channel));
  chip('connectionId', filters.connectionId, connections.find((connection) => connection.id === filters.connectionId)?.display_name ?? t(state, 'صندوق الوارد المحدد', 'Selected Inbox'));
  chip('labelId', filters.labelId, labels.find((label) => label.id === filters.labelId)?.name ?? t(state, 'الوسم المحدد', 'Selected label'));
  chip('campaignId', filters.campaignId, campaigns.find((campaign) => campaign.id === filters.campaignId)?.name ?? t(state, 'الحملة المحددة', 'Selected campaign'));
  chip('priority', filters.priority, enumLabel(state, { low: ['منخفضة','Low'], normal: ['عادية','Normal'], high: ['مرتفعة','High'], urgent: ['عاجلة','Urgent'] }, filters.priority));
  chip('status', filters.status, enumLabel(state, { open: ['مفتوحة','Open'], pending: ['بانتظار العميل','Pending'], snoozed: ['مؤجلة','Snoozed'], resolved: ['تم حلها','Resolved'], archived: ['مؤرشفة','Archived'] }, filters.status));
  return h('div', { class: 'filterbar', role: 'search', 'aria-label': t(state, 'نطاق تقرير التشغيل', 'Operational report scope') }, [
    h('div', { class: 'filterbar__fields' }, [
      h('label', { class: 'field field--compact' }, [
        h('span', { class: 'field__label' }, [t(state, 'من', 'From')]),
        h('input', { class: 'input', type: 'date', value: filters.from, max: filters.to === '' ? undefined : filters.to, 'data-act': 'live-report-filter', 'data-form': 'from', disabled: busy }),
      ]),
      h('label', { class: 'field field--compact' }, [
        h('span', { class: 'field__label' }, [t(state, 'إلى', 'To')]),
        h('input', { class: 'input', type: 'date', value: filters.to, min: filters.from === '' ? undefined : filters.from, 'data-act': 'live-report-filter', 'data-form': 'to', disabled: busy }),
      ]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'الوكيل', 'Agent')]), selectControl({ value: filters.agentId, act: 'live-report-filter', form: 'agentId', disabled: busy, options: [{ value: '', label: t(state, 'كل الوكلاء', 'All agents') }, ...agents.map((agent) => ({ value: agent.membershipId, label: agent.name }))] })]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'الفريق', 'Team')]), selectControl({ value: filters.teamId, act: 'live-report-filter', form: 'teamId', disabled: busy || teams.length === 0, options: options(teams, t(state, 'كل الفرق', 'All teams')) })]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'القناة', 'Channel')]), selectControl({ value: filters.channel, act: 'live-report-filter', form: 'channel', disabled: busy, options: [{ value: '', label: t(state, 'كل القنوات', 'All channels') }, ...Object.keys(CHANNEL_NAMES).map((kind) => ({ value: kind, label: phrase(state, CHANNEL_NAMES, kind) }))] })]),
    ]),
    h('details', { class: 'filterbar__more', open: filters.connectionId !== '' || filters.labelId !== '' || filters.campaignId !== '' || filters.priority !== '' || filters.status !== '' }, [
      h('summary', {}, [t(state, '+ فلاتر أخرى', '+ More filters')]),
      h('div', { class: 'filterbar__fields' }, [
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'صندوق الوارد', 'Inbox')]), selectControl({ value: filters.connectionId, act: 'live-report-filter', form: 'connectionId', disabled: busy || connections.length === 0, options: [{ value: '', label: t(state, 'كل الصناديق', 'All Inboxes') }, ...connections.map((connection) => ({ value: connection.id, label: connection.display_name }))] })]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'الوسم الحالي', 'Current label')]), selectControl({ value: filters.labelId, act: 'live-report-filter', form: 'labelId', disabled: busy || labels.length === 0, options: options(labels, t(state, 'كل الوسوم', 'All labels')) })]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'الحملة', 'Campaign')]), selectControl({ value: filters.campaignId, act: 'live-report-filter', form: 'campaignId', disabled: busy || campaigns.length === 0, options: options(campaigns, t(state, 'كل الحملات', 'All campaigns')) })]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'الأولوية', 'Priority')]), selectControl({ value: filters.priority, act: 'live-report-filter', form: 'priority', disabled: busy, options: [{ value: '', label: t(state, 'كل الأولويات', 'All priorities') }, ...['low','normal','high','urgent'].map((value) => ({ value, label: enumLabel(state, { low: ['منخفضة','Low'], normal: ['عادية','Normal'], high: ['مرتفعة','High'], urgent: ['عاجلة','Urgent'] }, value) }))] })]),
      h('label', { class: 'field field--compact' }, [h('span', { class: 'field__label' }, [t(state, 'الحالة', 'Status')]), selectControl({ value: filters.status, act: 'live-report-filter', form: 'status', disabled: busy, options: [{ value: '', label: t(state, 'كل الحالات', 'All statuses') }, ...['open','pending','snoozed','resolved','archived'].map((value) => ({ value, label: enumLabel(state, { open: ['مفتوحة','Open'], pending: ['بانتظار العميل','Pending'], snoozed: ['مؤجلة','Snoozed'], resolved: ['تم حلها','Resolved'], archived: ['مؤرشفة','Archived'] }, value) }))] })]),
      ]),
    ]),
    activeChips.length === 0 ? null : h('div', { class: 'filterbar__chips', 'aria-label': t(state, 'الفلاتر النشطة', 'Active filters') }, activeChips),
    h('div', { class: 'filterbar__actions' }, [
      Object.values(filters).some((value) => value !== '') ? button({ label: t(state, 'مسح التصفية', 'Clear filters'), act: 'live-report-filter-clear', small: true, variant: 'ghost' }) : null,
      button({ label: t(state, 'تحديث', 'Refresh'), icon: 'refresh', act: 'live-report-reload', small: true, busy }),
    ]),
  ]);
}

function enumLabel(state: AppState, labels: Readonly<Record<string, readonly [string,string]>>, value: string): string {
  const words = labels[value];
  return words === undefined ? value : t(state, words[0], words[1]);
}

function duration(state: AppState, seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return t(state, `${formatNumber(Math.round(seconds), state.lang)} ث`, `${formatNumber(Math.round(seconds), state.lang)} sec`);
  return t(state, `${formatNumber(Math.round(seconds / 60), state.lang)} د`, `${formatNumber(Math.round(seconds / 60), state.lang)} min`);
}

function operationsBody(state: AppState, report: OperationalReport): readonly Child[] {
  return [
    h('p', { class: 'freshness', 'data-operations-report-ready': 'true' }, [
      icon('clock', 14),
      t(state, `آخر تحديث ${stamp(state, report.generatedAt)} (UTC)`, `Updated ${stamp(state, report.generatedAt)} UTC`),
    ]),
    h('section', { class: 'kpis kpis--5', 'aria-label': t(state, 'مؤشرات التشغيل', 'Operational measures') }, [
      kpi(t(state, 'العمل المفتوح', 'Open workload'), formatNumber(report.conversations.open, state.lang)),
      kpi(t(state, 'غير معيّن', 'Unassigned'), formatNumber(report.conversations.unassigned, state.lang)),
      kpi(t(state, 'جديد في الفترة', 'New in period'), formatNumber(report.conversations.new, state.lang)),
      kpi(t(state, 'إسنادات في الفترة', 'Assignments in period'), formatNumber(report.conversations.assignedInPeriod, state.lang)),
      kpi(t(state, 'تم الحل', 'Resolved'), formatNumber(report.conversations.resolved, state.lang)),
    ]),
    h('section', { class: 'kpis kpis--5', 'aria-label': t(state, 'نشاط التشغيل', 'Operational activity') }, [
      kpi(t(state, 'رسائل بشرية', 'Human messages'), formatNumber(report.conversations.humanMessages, state.lang)),
      kpi(t(state, 'ملاحظات داخلية', 'Internal notes'), formatNumber(report.conversations.internalNotes, state.lang)),
      kpi(t(state, 'إعادات إسناد', 'Reassignments'), formatNumber(report.conversations.reassignments, state.lang)),
      kpi(t(state, 'متوسط أول رد', 'Avg. first response'), duration(state, report.timing.firstResponseAverageSeconds), { foot: t(state, `الوسيط ${duration(state, report.timing.firstResponseMedianSeconds)} · ${formatNumber(report.timing.firstResponseMeasured, state.lang)} محادثة`, `Median ${duration(state, report.timing.firstResponseMedianSeconds)} · ${formatNumber(report.timing.firstResponseMeasured, state.lang)} conversations`) }),
      kpi(t(state, 'متوسط زمن الحل', 'Avg. resolution'), duration(state, report.timing.resolutionAverageSeconds), { foot: t(state, `الوسيط ${duration(state, report.timing.resolutionMedianSeconds)} · ${formatNumber(report.timing.resolutionMeasured, state.lang)} حل`, `Median ${duration(state, report.timing.resolutionMedianSeconds)} · ${formatNumber(report.timing.resolutionMeasured, state.lang)} resolutions`) }),
    ]),
    h('div', { class: 'report-grid report-grid--3' }, [
      operationsBreakdown(state, t(state, 'العمل المفتوح حسب الحالة', 'Open workload by status'), t(state, 'الحالة', 'Status'), report.conversations.backlogByStatus),
      operationsBreakdown(state, t(state, 'العمل المفتوح حسب القناة', 'Open workload by channel'), t(state, 'القناة', 'Channel'), report.conversations.backlogByChannel),
      operationsBreakdown(state, t(state, 'العمل المفتوح حسب الفريق', 'Open workload by team'), t(state, 'الفريق', 'Team'), report.conversations.backlogByTeam),
      operationsBreakdown(state, t(state, 'توزيع زمن أول رد', 'First-response distribution'), t(state, 'المدة', 'Duration'), report.responseBuckets.map((row) => ({ count: row.count, team: row.bucket }))),
    ]),
    channelActivityReport(state, report),
    h('div', { class: 'report-grid' }, [
      workload(state, report),
      agentActivity(state, report),
    ]),
    agentDetail(state, report),
    notice('plain', 'info', h('strong', {}, [t(state, 'تعريف القياس. ', 'Measurement definition. ')]), t(state, 'متوسط أول رد وحل المحادثة يُحسبان من حلقات المحادثة الدائمة التي تحمل دليلاً على منفّذ الإجراء. السجل التاريخي بلا منفّذ لا يُنسب إلى أي وكيل.', 'First-response and resolution averages use durable conversation episodes with recorded actors. Historical episodes without an actor are not attributed to an agent.')),
  ];
}

function channelActivityReport(state: AppState, report: OperationalReport): HTMLElement {
  const columns = [
    t(state, 'القناة', 'Channel'), t(state, 'نشط الآن', 'Active now'), t(state, 'جديد', 'New'),
    t(state, 'تم التعامل', 'Handled'), t(state, 'رسائل بشرية', 'Human messages'),
    t(state, 'متوسط أول رد', 'Avg. first response'), t(state, 'وسيط أول رد', 'Median first response'),
    t(state, 'الحلول', 'Resolved'), t(state, 'متوسط الحل', 'Avg. resolution'), t(state, 'وسيط الحل', 'Median resolution'),
  ];
  return panel(t(state, 'الأداء حسب القناة', 'Channel performance'), [
    report.channels.length === 0
      ? emptyState({ icon: 'inbox', title: t(state, 'لا توجد بيانات قنوات', 'No channel data'), body: t(state, 'ستظهر القنوات عندما توجد محادثات مقروءة ضمن النطاق.', 'Channels appear when readable conversations exist in scope.') })
      : h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
        h('thead', {}, [h('tr', {}, columns.map((label, index) => h('th', { scope: 'col', class: index === 0 ? undefined : 'num' }, [label])))]),
        h('tbody', {}, report.channels.map((row) => h('tr', { 'data-channel': row.channel }, [
          h('th', { scope: 'row' }, [phrase(state, CHANNEL_NAMES, row.channel), h('div', { class: 'filterbar__actions' }, [channelInboxLink(state, row.channel)])]),
          h('td', { class: 'num' }, [formatNumber(row.currentActive, state.lang)]), h('td', { class: 'num' }, [formatNumber(row.newConversations, state.lang)]),
          h('td', { class: 'num' }, [formatNumber(row.handledConversations, state.lang)]), h('td', { class: 'num' }, [formatNumber(row.humanMessages, state.lang)]),
          h('td', { class: 'num' }, [duration(state, row.firstResponseAverageSeconds)]), h('td', { class: 'num' }, [duration(state, row.firstResponseMedianSeconds)]),
          h('td', { class: 'num' }, [formatNumber(row.resolutions, state.lang)]), h('td', { class: 'num' }, [duration(state, row.resolutionAverageSeconds)]),
          h('td', { class: 'num' }, [duration(state, row.resolutionMedianSeconds)]),
        ]))),
      ])]),
  ], { flush: true });
}

function channelInboxLink(state: AppState, channel: string): HTMLElement {
  const filters = [{ key: 'channel', operator: 'eq', value: channel }];
  return h('a', { class: 'btn btn--ghost btn--sm', href: formatHash({ screen: 'inbox', conversationId: null, params: { scope: 'all', filters: JSON.stringify(filters), lang: state.lang } }) }, [t(state, 'عرض في الوارد', 'View in Inbox')]);
}

/** The supervisor banner carries an opaque membership ID into this view. */
function agentDetail(state: AppState, report: OperationalReport): Child {
  const id = state.route.params.agent;
  if (id === undefined) return null;
  const agent = report.agents.find((row) => row.membershipId === id);
  if (agent === undefined) return notice('warning', 'people', t(state, 'الوكيل لم يعد ضمن نطاق التقرير.', 'That agent is no longer within this report scope.'));
  return panel(t(state, `تفاصيل ${agent.name}`, `${agent.name} detail`), [
    h('p', { class: 'table__secondary' }, [agent.email, agent.teams.length === 0 ? '' : ` · ${agent.teams.join(' · ')}`]),
    h('section', { class: 'kpis kpis--5', 'aria-label': t(state, 'مقاييس الوكيل', 'Agent measures') }, [
      kpi(t(state, 'مُسند الآن', 'Current assigned'), formatNumber(agent.currentAssigned, state.lang)),
      kpi(t(state, 'مفتوح', 'Open'), formatNumber(agent.currentOpen, state.lang)),
      kpi(t(state, 'بانتظار العميل', 'Pending'), formatNumber(agent.currentPending, state.lang)),
      kpi(t(state, 'مؤجل', 'Snoozed'), formatNumber(agent.currentSnoozed, state.lang)),
      kpi(t(state, 'بلا رد بشري', 'Unreplied'), formatNumber(agent.currentUnreplied, state.lang)),
    ]),
    h('section', { class: 'kpis kpis--5', 'aria-label': t(state, 'نشاط الوكيل خلال الفترة', 'Agent activity in period') }, [
      kpi(t(state, 'إسنادات', 'Assignments'), formatNumber(agent.assignedInPeriod, state.lang)),
      kpi(t(state, 'تم التعامل', 'Handled'), formatNumber(agent.handledConversations, state.lang)),
      kpi(t(state, 'رسائل بشرية', 'Human messages'), formatNumber(agent.humanMessages, state.lang)),
      kpi(t(state, 'ملاحظات', 'Notes'), formatNumber(agent.internalNotes, state.lang)),
      kpi(t(state, 'إعادات إسناد', 'Reassignments'), formatNumber(agent.reassignments, state.lang)),
    ]),
    h('section', { class: 'kpis kpis--4', 'aria-label': t(state, 'أزمنة الأداء', 'Response and resolution times') }, [
      kpi(t(state, 'أول رد', 'First responses'), formatNumber(agent.firstResponses, state.lang)),
      kpi(t(state, 'متوسط أول رد', 'Avg. first response'), duration(state, agent.firstResponseAverageSeconds), { foot: t(state, `الوسيط ${duration(state, agent.firstResponseMedianSeconds)}`, `Median ${duration(state, agent.firstResponseMedianSeconds)}`) }),
      kpi(t(state, 'حلقات محلولة', 'Resolved episodes'), formatNumber(agent.resolutions, state.lang)),
      kpi(t(state, 'متوسط الحل', 'Avg. resolution'), duration(state, agent.resolutionAverageSeconds), { foot: t(state, `الوسيط ${duration(state, agent.resolutionMedianSeconds)}`, `Median ${duration(state, agent.resolutionMedianSeconds)}`) }),
    ]),
    h('div', { class: 'report-grid' }, [
      operationsBreakdown(state, t(state, 'الحمل الحالي حسب الحالة', 'Current workload by status'), t(state, 'الحالة', 'Status'), agent.currentByStatus),
      operationsBreakdown(state, t(state, 'الحمل الحالي حسب القناة', 'Current workload by channel'), t(state, 'القناة', 'Channel'), agent.currentByChannel),
    ]),
    h('div', { class: 'filterbar__actions', 'aria-label': t(state, 'فتح محادثات الوكيل', 'Open agent conversations') }, [
      reportInboxLink(state, agent.membershipId, 'open'),
      reportInboxLink(state, agent.membershipId, 'unreplied'),
      reportInboxLink(state, agent.membershipId, 'high'),
      reportInboxLink(state, agent.membershipId, 'all'),
    ]),
  ]);
}

function reportInboxLink(state: AppState, membershipId: string, kind: 'all' | 'open' | 'unreplied' | 'high'): HTMLElement {
  const labels = {
    all: t(state, 'كل الحالي', 'All current'),
    open: t(state, 'فتح المحادثات المفتوحة', 'Open conversations'),
    unreplied: t(state, 'غير المردود عليها', 'Unreplied'),
    high: t(state, 'الأولوية المرتفعة', 'High priority'),
  };
  const filters = [
    { key: 'assigned_agent_id', operator: 'eq', value: membershipId },
    ...(kind === 'open' ? [{ key: 'status', operator: 'eq', value: 'open' }] : []),
    ...(kind === 'unreplied' ? [{ key: 'unreplied', operator: 'eq', value: true }] : []),
    ...(kind === 'high' ? [{ key: 'priority', operator: 'eq', value: 'high' }] : []),
  ];
  return h('a', { class: 'btn btn--ghost btn--sm', href: formatHash({ screen: 'inbox', conversationId: null, params: { scope: 'all', filters: JSON.stringify(filters), lang: state.lang } }) }, [labels[kind]]);
}

function operationsBreakdown(state: AppState, title: string, label: string, rows: readonly { readonly count: number; readonly status?: string; readonly channel?: string; readonly team?: string }[]): HTMLElement {
  if (rows.length === 0) return panel(title, [emptyState({ icon: 'inbox', title: t(state, 'لا يوجد عمل مفتوح', 'No open workload'), body: t(state, 'لا توجد محادثات ضمن هذا التجميع الآن.', 'There are no conversations in this grouping right now.') })]);
  return panel(title, [h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
    h('thead', {}, [h('tr', {}, [h('th', { scope: 'col' }, [label]), h('th', { scope: 'col', class: 'num' }, [t(state, 'المحادثات', 'Conversations')])])]),
    h('tbody', {}, rows.map((row) => h('tr', {}, [h('td', {}, [row.status ?? row.channel ?? row.team ?? '—']), h('td', { class: 'num' }, [formatNumber(row.count, state.lang)])]))),
  ])])], { flush: true });
}

function workload(state: AppState, report: OperationalReport): HTMLElement {
  const rows = report.conversations.assignmentWorkload;
  if (rows.length === 0) return panel(t(state, 'حمل التعيين', 'Assignment workload'), [emptyState({ icon: 'people', title: t(state, 'لا توجد محادثات معيّنة', 'No assigned conversations'), body: t(state, 'المحادثات المفتوحة المعيّنة تظهر هنا حسب الوكيل.', 'Assigned open conversations appear here by agent.') })]);
  return operationsBreakdown(state, t(state, 'حمل التعيين', 'Assignment workload'), t(state, 'الوكيل', 'Agent'), rows);
}

function agentActivity(state: AppState, report: OperationalReport): HTMLElement {
  if (report.agents.length === 0) return panel(t(state, 'نشاط الوكلاء', 'Agent activity'), [emptyState({ icon: 'people', title: t(state, 'لا توجد أحداث منسوبة', 'No attributed events'), body: t(state, 'تظهر هنا الردود الأولى وعمليات الحل التي تحمل منفّذًا محفوظًا.', 'First responses and resolutions with a recorded actor appear here.') })]);
  return panel(t(state, 'أداء الوكلاء', 'Agent performance'), [h('div', { class: 'tablewrap' }, [h('table', { class: 'table table--compact' }, [
    h('thead', {}, [h('tr', {}, [
      h('th', { scope: 'col' }, [t(state, 'الوكيل', 'Agent')]), h('th', { scope: 'col', class: 'num' }, [t(state, 'الحمل الحالي', 'Active workload')]),
      h('th', { scope: 'col', class: 'num' }, [t(state, 'أُسندت في الفترة', 'Assigned in period')]), h('th', { scope: 'col', class: 'num' }, [t(state, 'تم التعامل', 'Handled')]),
      h('th', { scope: 'col', class: 'num' }, [t(state, 'رسائل بشرية', 'Human messages')]), h('th', { scope: 'col', class: 'num' }, [t(state, 'ملاحظات', 'Notes')]),
      h('th', { scope: 'col', class: 'num' }, [t(state, 'أول رد', 'First responses')]), h('th', { scope: 'col', class: 'num' }, [t(state, 'حلول', 'Resolutions')]),
      h('th', { scope: 'col', class: 'num' }, [t(state, 'إعادات إسناد', 'Reassignments')]),
    ])]),
    h('tbody', {}, report.agents.map((agent) => h('tr', { 'data-agent-id': agent.membershipId }, [
      h('td', {}, [h('a', { href: formatHash({ screen: 'analytics', conversationId: null, params: { ...routeParamsFor(state), view: 'agents', agent: agent.membershipId, agentFilter: agent.membershipId } }) }, [h('strong', {}, [isolated(agent.name)])]), h('span', { class: 'table__secondary', dir: 'ltr' }, [isolated(agent.email)])]),
      h('td', { class: 'num' }, [formatNumber(agent.currentAssigned, state.lang)]), h('td', { class: 'num' }, [formatNumber(agent.assignedInPeriod, state.lang)]),
      h('td', { class: 'num' }, [formatNumber(agent.handledConversations, state.lang)]), h('td', { class: 'num' }, [formatNumber(agent.humanMessages, state.lang)]),
      h('td', { class: 'num' }, [formatNumber(agent.internalNotes, state.lang)]), h('td', { class: 'num' }, [formatNumber(agent.firstResponses, state.lang)]),
      h('td', { class: 'num' }, [formatNumber(agent.resolutions, state.lang)]), h('td', { class: 'num' }, [formatNumber(agent.reassignments, state.lang)]),
    ]))),
  ])])], { flush: true });
}

/* ---------------------------------------------------------------- filters -- */

function filterBar(state: AppState, report: CampaignReport | null): HTMLElement {
  const live = state.live;
  const filters = state.analyticsFilters;
  const narrowed = filters.from !== '' || filters.to !== '' || filters.channel !== '' || filters.campaignId !== '';
  const busy = live.campaignReport.status === 'loading';
  const channels = report === null ? [] : report.channels.map((channel) => channel.kind);
  const channelOptions = [...new Set([...channels, ...(filters.channel === '' ? [] : [filters.channel])])];
  return h('div', { class: 'filterbar', role: 'search', 'aria-label': t(state, 'نطاق التقرير', 'Report scope') }, [
    h('div', { class: 'filterbar__fields' }, [
      h('label', { class: 'field field--compact' }, [
        h('span', { class: 'field__label' }, [t(state, 'من', 'From')]),
        h('input', { class: 'input', type: 'date', value: filters.from, max: filters.to === '' ? undefined : filters.to, 'data-act': 'live-report-filter', 'data-form': 'from', disabled: busy }),
      ]),
      h('label', { class: 'field field--compact' }, [
        h('span', { class: 'field__label' }, [t(state, 'إلى', 'To')]),
        h('input', { class: 'input', type: 'date', value: filters.to, min: filters.from === '' ? undefined : filters.from, 'data-act': 'live-report-filter', 'data-form': 'to', disabled: busy }),
      ]),
      h('label', { class: 'field field--compact' }, [
        h('span', { class: 'field__label' }, [t(state, 'القناة', 'Channel')]),
        selectControl({
          value: filters.channel,
          act: 'live-report-filter',
          form: 'channel',
          disabled: busy,
          options: [
            { value: '', label: t(state, 'كل القنوات', 'All channels') },
            ...channelOptions.map((kind) => ({ value: kind, label: phrase(state, CHANNEL_NAMES, kind) })),
          ],
        }),
      ]),
      h('label', { class: 'field field--compact' }, [
        h('span', { class: 'field__label' }, [t(state, 'الحملة', 'Campaign')]),
        selectControl({
          value: filters.campaignId,
          act: 'live-report-filter',
          form: 'campaignId',
          disabled: busy,
          options: [
            { value: '', label: t(state, 'كل الحملات', 'All campaigns') },
            ...live.reportCampaigns.map((campaign) => ({ value: campaign.id, label: campaign.name })),
          ],
        }),
      ]),
    ]),
    h('div', { class: 'filterbar__actions' }, [
      narrowed ? button({ label: t(state, 'مسح التصفية', 'Clear filters'), act: 'live-report-filter-clear', small: true, variant: 'ghost' }) : null,
      button({ label: t(state, 'تحديث', 'Refresh'), icon: 'refresh', act: 'live-report-reload', small: true, busy }),
      button({
        label: t(state, 'تصدير CSV', 'Export CSV'),
        icon: 'download',
        act: 'live-report-export',
        small: true,
        variant: 'primary',
        busy: live.busy === 'campaign-report-export',
        disabled: report === null,
      }),
    ]),
  ]);
}

/* ----------------------------------------------------------------- report -- */

function reportBody(state: AppState, report: CampaignReport): readonly Child[] {
  const recipients = report.milestones.denominator;
  return [
    h('p', { class: 'freshness', 'data-report-ready': 'true' }, [
      icon('clock', 14),
      t(state, `البيانات حتى ${stamp(state, report.fresh_through)} (UTC) · النسب من ${formatNumber(recipients, state.lang)} مستلم`, `Data through ${stamp(state, report.fresh_through)} UTC · percentages of ${formatNumber(recipients, state.lang)} recipients`),
    ]),
    exportStatus(state),
    kpiStrip(state, report),
    recipients === 0
      ? panel(t(state, 'مسار التسليم', 'Delivery funnel'), [
          emptyState({
            icon: 'funnel',
            title: t(state, 'لا يوجد مستلمون في هذا النطاق', 'No recipients in this scope'),
            body: t(state, 'وسّع الفترة أو امسح التصفية، أو أطلق حملة لتظهر نتائجها هنا.', 'Widen the period or clear filters, or launch a campaign to see results here.'),
          }),
        ])
      : h('div', { class: 'report-grid' }, [funnel(state, report), trend(state, report.trend)]),
    h('div', { class: 'report-grid report-grid--3' }, [channelBreakdown(state, report), errorBreakdown(state, report), currentStates(state, report)]),
    campaignTable(state, report),
    costs(state, report),
  ];
}

function kpiStrip(state: AppState, report: CampaignReport): HTMLElement {
  const m = report.milestones;
  const of = (value: number): string => t(state, `${percent(state, value, m.denominator)} من المستلمين`, `${percent(state, value, m.denominator)} of recipients`);
  return h('section', { class: 'kpis kpis--7', 'aria-label': t(state, 'المؤشرات الرئيسية', 'Key figures') }, [
    kpi(t(state, 'الجمهور', 'Audience'), formatNumber(report.audience.denominator, state.lang), {
      foot: t(state, `${formatNumber(report.audience.excluded, state.lang)} مستبعد`, `${formatNumber(report.audience.excluded, state.lang)} excluded`),
    }),
    kpi(t(state, 'المستلمون', 'Recipients'), formatNumber(m.denominator, state.lang), {
      foot: t(state, `${formatNumber(report.definitions.executions, state.lang)} تنفيذ`, `${formatNumber(report.definitions.executions, state.lang)} executions`),
    }),
    kpi(t(state, 'أُرسلت', 'Sent'), formatNumber(m.accepted, state.lang), { foot: of(m.accepted) }),
    kpi(t(state, 'سُلّمت', 'Delivered'), formatNumber(m.delivered, state.lang), { foot: of(m.delivered) }),
    kpi(t(state, 'قُرئت', 'Read'), formatNumber(m.read, state.lang), { foot: of(m.read) }),
    kpi(t(state, 'فشلت', 'Failed'), formatNumber(report.current.failed, state.lang), { foot: of(report.current.failed), tone: report.current.failed > 0 ? 'danger' : undefined }),
    kpi(t(state, 'الردود', 'Replies'), t(state, 'غير مقاسة', 'Not measured'), {
      foot: t(state, 'لا يقيسها التقرير بعد', 'Not measured by the report yet'),
      unavailable: true,
    }),
  ]);
}

/** Accepted → Delivered → Read, each against the same published denominator. */
function funnel(state: AppState, report: CampaignReport): HTMLElement {
  const m = report.milestones;
  const stages: readonly { readonly label: string; readonly value: number | null; readonly previous: number }[] = [
    { label: t(state, 'المستلمون', 'Recipients'), value: m.denominator, previous: m.denominator },
    { label: t(state, 'أُرسلت (قبلها المزوّد)', 'Sent (accepted by provider)'), value: m.accepted, previous: m.denominator },
    { label: t(state, 'سُلّمت', 'Delivered'), value: m.delivered, previous: m.accepted },
    { label: t(state, 'قُرئت', 'Read'), value: m.read, previous: m.delivered },
    { label: t(state, 'ردّ العميل', 'Replied'), value: null, previous: m.read },
  ];
  const missingReceipts = report.channels.filter((channel) => !channel.read_receipts);
  return panel(t(state, 'مسار التسليم', 'Delivery funnel'), [
    h('ol', { class: 'funnel' }, stages.map((stage, index) =>
      h('li', { class: stage.value === null ? 'funnel__stage funnel__stage--unavailable' : 'funnel__stage' }, [
        h('div', { class: 'funnel__head' }, [
          h('span', { class: 'funnel__label' }, [stage.label]),
          h('span', { class: 'funnel__value' }, [
            stage.value === null ? t(state, 'غير مقاس', 'Not measured') : isolated(formatNumber(stage.value, state.lang)),
          ]),
        ]),
        stage.value === null
          ? h('div', { class: 'funnel__track funnel__track--empty' })
          : progress(stage.value / Math.max(m.denominator, 1), t(state, `${stage.label}: ${percent(state, stage.value, m.denominator)} من المستلمين`, `${stage.label}: ${percent(state, stage.value, m.denominator)} of recipients`)),
        h('div', { class: 'funnel__foot' }, [
          stage.value === null
            ? t(state, 'لا تتوفر بيانات ردود في التقرير.', 'The report has no reply data.')
            : index === 0
              ? t(state, 'المقام لكل النسب', 'Denominator for every percentage')
              : t(state, `${percent(state, stage.value, m.denominator)} من المستلمين · ${percent(state, stage.value, stage.previous)} من المرحلة السابقة`, `${percent(state, stage.value, m.denominator)} of recipients · ${percent(state, stage.value, stage.previous)} of previous step`),
        ]),
      ]),
    )),
    missingReceipts.length === 0
      ? null
      : notice('info', 'info', t(
          state,
          `${missingReceipts.map((channel) => phrase(state, CHANNEL_NAMES, channel.kind)).join('، ')} لا ترسل إيصالات قراءة، فتظهر نسبة القراءة أقل من الحقيقة لهذه القنوات.`,
          `${missingReceipts.map((channel) => phrase(state, CHANNEL_NAMES, channel.kind)).join(', ')} do not report reads, so read rates understate those channels.`,
        )),
  ], { description: t(state, 'كل مرحلة من نفس المقام المنشور.', 'Every stage uses the same published denominator.') });
}

/**
 * Volume per launch day, with the delivery rate drawn over it.
 *
 * The SVG is presentational; the table under it carries the same numbers for
 * anybody not reading the picture. Time runs left to right in both languages:
 * a chart is not text, and mirroring it would reverse the axis.
 */
function trend(state: AppState, days: readonly CampaignReportTrendDay[]): HTMLElement {
  const title = t(state, 'الحجم عبر الوقت', 'Volume over time');
  if (days.length === 0) {
    return panel(title, [emptyState({ icon: 'sparkline', title: t(state, 'لا توجد أيام في النطاق', 'No days in this scope'), body: t(state, 'تظهر الأيام هنا بعد إطلاق حملة.', 'Days appear here once a campaign launches.') })]);
  }
  const width = 560;
  const height = 180;
  const padding = { top: 12, bottom: 28, left: 36, right: 12 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(...days.map((day) => day.recipients), 1);
  const step = plotWidth / days.length;
  const barWidth = Math.max(Math.min(step * 0.6, 36), 4);
  const dayFormat = dateFormat(state.lang, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const label = (day: string): string => dayFormat.format(new Date(`${day}T00:00:00Z`));
  const bars = days.map((day, index) => {
    const x = padding.left + index * step + (step - barWidth) / 2;
    const barHeight = (day.recipients / max) * plotHeight;
    return `<rect class="chart__bar" x="${x.toFixed(1)}" y="${(padding.top + plotHeight - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3"/>`;
  });
  const points = days.map((day, index) => {
    const x = padding.left + index * step + step / 2;
    const rate = day.recipients === 0 ? 0 : day.delivered / day.recipients;
    return `${x.toFixed(1)},${(padding.top + plotHeight - rate * plotHeight).toFixed(1)}`;
  });
  const every = Math.max(1, Math.ceil(days.length / 6));
  const ticks = days
    .map((day, index) => index % every === 0
      ? `<text class="chart__tick" x="${(padding.left + index * step + step / 2).toFixed(1)}" y="${String(height - 8)}" text-anchor="middle">${label(day.day)}</text>`
      : '')
    .join('');
  const markup = [
    `<line class="chart__axis" x1="${String(padding.left)}" y1="${String(padding.top + plotHeight)}" x2="${String(width - padding.right)}" y2="${String(padding.top + plotHeight)}"/>`,
    `<text class="chart__tick" x="${String(padding.left - 6)}" y="${String(padding.top + 4)}" text-anchor="end">${formatNumber(max, state.lang)}</text>`,
    `<text class="chart__tick" x="${String(padding.left - 6)}" y="${String(padding.top + plotHeight)}" text-anchor="end">0</text>`,
    ...bars,
    days.length > 1 ? `<polyline class="chart__line" points="${points.join(' ')}"/>` : '',
    ...points.map((point) => `<circle class="chart__point" cx="${point.split(',')[0] as string}" cy="${point.split(',')[1] as string}" r="3"/>`),
    ticks,
  ].join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = markup;
  return panel(title, [
    h('div', { class: 'chart-legend', 'aria-hidden': 'true' }, [
      h('span', { class: 'chart-legend__item chart-legend__item--bar' }, [t(state, 'المستلمون حسب يوم الإطلاق', 'Recipients by launch day')]),
      h('span', { class: 'chart-legend__item chart-legend__item--line' }, [t(state, 'نسبة التسليم', 'Delivery rate')]),
    ]),
    h('figure', { class: 'chart-figure', dir: 'ltr' }, [
      svg,
      h('figcaption', { class: 'visually-hidden' }, [title]),
    ]),
    h('div', { class: 'tablewrap' }, [
      h('table', { class: 'table table--compact visually-hidden-table' }, [
        h('caption', { class: 'visually-hidden' }, [t(state, 'بيانات الحجم اليومي', 'Daily volume data')]),
        h('thead', {}, [h('tr', {}, [
          h('th', { scope: 'col' }, [t(state, 'اليوم', 'Day')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'المستلمون', 'Recipients')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'سُلّمت', 'Delivered')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'نسبة التسليم', 'Delivery rate')]),
        ])]),
        h('tbody', {}, days.map((day) => h('tr', {}, [
          h('td', {}, [label(day.day)]),
          h('td', { class: 'num' }, [formatNumber(day.recipients, state.lang)]),
          h('td', { class: 'num' }, [formatNumber(day.delivered, state.lang)]),
          h('td', { class: 'num' }, [percent(state, day.delivered, day.recipients)]),
        ]))),
      ]),
    ]),
  ], { description: t(state, 'حسب يوم إطلاق التنفيذ بتوقيت UTC.', 'By execution launch day, UTC.') });
}

function channelBreakdown(state: AppState, report: CampaignReport): HTMLElement {
  const title = t(state, 'حسب القناة', 'By channel');
  if (report.channels.length === 0) {
    return panel(title, [emptyState({ icon: 'channels', title: t(state, 'لا توجد بيانات قنوات', 'No channel data'), body: t(state, 'تظهر القنوات بعد أول تنفيذ.', 'Channels appear after the first execution.') })]);
  }
  return panel(title, [
    h('div', { class: 'tablewrap' }, [
      h('table', { class: 'table table--compact' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { scope: 'col' }, [t(state, 'القناة', 'Channel')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'المستلمون', 'Recipients')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'سُلّمت', 'Delivered')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'قُرئت', 'Read')]),
        ])]),
        h('tbody', {}, report.channels.map((channel) => h('tr', {}, [
          h('td', {}, [phrase(state, CHANNEL_NAMES, channel.kind)]),
          h('td', { class: 'num' }, [formatNumber(channel.denominator, state.lang)]),
          h('td', { class: 'num' }, [channel.delivery_receipts ? percent(state, channel.delivered, channel.denominator) : h('span', { class: 'muted' }, [t(state, 'غير متاح', 'Not reported')])]),
          h('td', { class: 'num' }, [channel.read_receipts ? percent(state, channel.read, channel.denominator) : h('span', { class: 'muted' }, [t(state, 'غير متاح', 'Not reported')])]),
        ]))),
      ]),
    ]),
  ], { flush: true });
}

function errorBreakdown(state: AppState, report: CampaignReport): HTMLElement {
  const title = t(state, 'أسباب الفشل', 'Failure reasons');
  const total = report.errors.reduce((sum, error) => sum + error.count, 0);
  if (total === 0) {
    return panel(title, [emptyState({ icon: 'check', title: t(state, 'لا توجد أخطاء مسجلة', 'No failures recorded'), body: t(state, 'لم يفشل أو يُتخطَّ أي مستلم في هذا النطاق.', 'No recipient failed or was skipped in this scope.') })]);
  }
  return panel(title, [
    h('ul', { class: 'barlist' }, report.errors.map((error) =>
      h('li', { class: 'barlist__row' }, [
        h('div', { class: 'barlist__head' }, [
          h('span', { class: 'barlist__label' }, [phrase(state, ERROR_CODES, error.code)]),
          h('span', { class: 'barlist__value' }, [formatNumber(error.count, state.lang)]),
        ]),
        progress(error.count / total, t(state, `${phrase(state, ERROR_CODES, error.code)}: ${percent(state, error.count, total)} من الإخفاقات`, `${phrase(state, ERROR_CODES, error.code)}: ${percent(state, error.count, total)} of failures`), 'danger'),
      ]),
    )),
  ], { description: t(state, `من ${formatNumber(total, state.lang)} مستلم فشل أو تم تخطيه أو بنتيجة غير معروفة`, `Of ${formatNumber(total, state.lang)} failed, skipped or unknown recipients`) });
}

const CURRENT_KEYS = ['planned', 'queued', 'in_flight', 'accepted', 'delivered', 'read', 'failed', 'skipped', 'cancelled', 'outcome_unknown'] as const;

const CURRENT_TONE: Readonly<Record<(typeof CURRENT_KEYS)[number], Tone>> = {
  planned: 'neutral', queued: 'neutral', in_flight: 'accent', accepted: 'accent', delivered: 'success',
  read: 'success', failed: 'danger', skipped: 'warning', cancelled: 'neutral', outcome_unknown: 'unknown',
};

/** Where every recipient is right now. The states are disjoint and sum to the denominator. */
function currentStates(state: AppState, report: CampaignReport): HTMLElement {
  const current = report.current;
  const present = CURRENT_KEYS.filter((key) => current[key] > 0);
  return panel(t(state, 'الحالة الحالية', 'Current state'), [
    present.length === 0
      ? emptyState({ icon: 'users', title: t(state, 'لا يوجد مستلمون', 'No recipients'), body: t(state, 'لا توجد حالات لعرضها في هذا النطاق.', 'There is nothing to show in this scope.') })
      : h('ul', { class: 'barlist' }, present.map((key) =>
          h('li', { class: 'barlist__row' }, [
            h('div', { class: 'barlist__head' }, [
              h('span', { class: 'barlist__label' }, [phrase(state, RECIPIENT_STATES, key)]),
              h('span', { class: 'barlist__value' }, [`${formatNumber(current[key], state.lang)} · ${percent(state, current[key], current.denominator)}`]),
            ]),
            progress(current[key] / Math.max(current.denominator, 1), `${phrase(state, RECIPIENT_STATES, key)}: ${percent(state, current[key], current.denominator)}`, CURRENT_TONE[key]),
          ]),
        )),
  ], { description: t(state, 'حالات منفصلة مجموعها عدد المستلمين. النتيجة غير المعروفة لا تُعاد تلقائيًا.', 'Disjoint states that sum to recipients. Unknown outcomes are never retried automatically.') });
}

function campaignTable(state: AppState, report: CampaignReport): HTMLElement {
  const title = t(state, 'الحملات', 'Campaigns');
  if (report.campaigns.length === 0) {
    return panel(title, [emptyState({ icon: 'broadcasts', title: t(state, 'لا توجد حملات في هذا النطاق', 'No campaigns in this scope'), body: t(state, 'غيّر التصفية لعرض حملات أخرى.', 'Change the filters to see other campaigns.') })]);
  }
  return panel(title, [
    h('div', { class: 'tablewrap' }, [
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { scope: 'col' }, [t(state, 'الحملة', 'Campaign')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'مشمول / مستبعد', 'Included / excluded')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'أُرسلت', 'Sent')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'سُلّمت', 'Delivered')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'قُرئت', 'Read')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'فشلت', 'Failed')]),
          h('th', { scope: 'col' }, [t(state, 'التقدم', 'Progress')]),
          h('th', { scope: 'col' }, [t(state, 'آخر تحديث', 'Last update')]),
          h('th', { scope: 'col' }, [h('span', { class: 'visually-hidden' }, [t(state, 'إجراء', 'Action')])]),
        ])]),
        h('tbody', {}, report.campaigns.map((campaign) => {
          const processed = campaign.denominator - campaign.pending;
          return h('tr', { 'data-report-campaign': campaign.id }, [
            h('td', {}, [h('span', { class: 'table__primary' }, [campaign.name]), campaignStateBadge(state, campaign.state)]),
            h('td', { class: 'num' }, [
              // Both come from the same snapshot, so they are null together.
              campaign.included === null ? '—' : `${formatNumber(campaign.included, state.lang)} / ${formatNumber(campaign.excluded as number, state.lang)}`,
            ]),
            h('td', { class: 'num' }, [formatNumber(campaign.accepted, state.lang)]),
            h('td', { class: 'num' }, [formatNumber(campaign.delivered, state.lang)]),
            h('td', { class: 'num' }, [formatNumber(campaign.read, state.lang)]),
            h('td', { class: 'num' }, [campaign.failed > 0 ? badge(formatNumber(campaign.failed, state.lang), 'danger') : '0']),
            h('td', {}, [
              campaign.denominator === 0
                ? h('span', { class: 'muted' }, [t(state, 'لم يبدأ', 'Not started')])
                : h('div', { class: 'progress-cell' }, [
                    progress(processed / campaign.denominator, t(state, `اكتمل ${percent(state, processed, campaign.denominator)}`, `${percent(state, processed, campaign.denominator)} processed`)),
                    h('span', { class: 'progress-cell__value' }, [percent(state, processed, campaign.denominator)]),
                  ]),
            ]),
            h('td', {}, [stamp(state, campaign.fresh_through)]),
            h('td', {}, [h('div', { class: 'filterbar__actions' }, [
              button({ label: t(state, 'فتح', 'Open'), act: 'campaign-open', arg: campaign.id, small: true, variant: 'ghost', title: t(state, `فتح ${campaign.name}`, `Open ${campaign.name}`) }),
              campaignInboxLink(state, campaign.id),
            ])]),
          ]);
        })),
      ]),
    ]),
  ], { flush: true });
}

function campaignInboxLink(state: AppState, campaignId: string): HTMLElement {
  const filters = [{ key: 'campaign_id', operator: 'eq', value: campaignId }];
  return h('a', { class: 'btn btn--ghost btn--sm', href: formatHash({ screen: 'inbox', conversationId: null, params: { scope: 'all', filters: JSON.stringify(filters), lang: state.lang } }) }, [
    t(state, 'المحادثات المنسوبة', 'Attributed conversations'),
  ]);
}

function costs(state: AppState, report: CampaignReport): HTMLElement | null {
  if (report.costs.length === 0) return null;
  return panel(t(state, 'التكلفة', 'Cost'), [
    h('div', { class: 'tablewrap' }, [
      h('table', { class: 'table table--compact' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', { scope: 'col' }, [t(state, 'العملة', 'Currency')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'مقدّرة', 'Estimated')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'محجوزة', 'Committed')]),
          h('th', { scope: 'col', class: 'num' }, [t(state, 'مطابقة مع المزوّد', 'Reconciled')]),
        ])]),
        h('tbody', {}, report.costs.map((cost) => h('tr', {}, [
          h('td', {}, [isolated(cost.currency)]),
          h('td', { class: 'num' }, [isolated(cost.estimated_amount_minor, true)]),
          h('td', { class: 'num' }, [isolated(cost.committed_amount_minor, true)]),
          h('td', { class: 'num' }, [isolated(cost.reconciled_amount_minor, true)]),
        ]))),
      ]),
    ]),
  ], { flush: true, description: t(state, 'المقدّر والمحجوز والمطابق أرقام منفصلة ولا تُجمع.', 'Estimated, committed and reconciled are separate figures and are not added together.') });
}

/* ----------------------------------------------------------------- export -- */

type ExportView = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

export function exportView(job: CampaignReportExport, now: Date): ExportView {
  if (job.state === 'completed' && job.expires_at !== null && new Date(job.expires_at).getTime() <= now.getTime()) {
    return 'expired';
  }
  return job.state;
}

function exportStatus(state: AppState): Child {
  const resource = state.live.campaignReportExport;
  if (resource.status === 'idle' || resource.status === 'loading') return null;
  if (resource.status === 'error') return inlineError(state, resource.error);
  const job = resource.value;
  const view = exportView(job, state.clock);
  const scope = job.campaign_id === null
    ? t(state, 'كل الحملات', 'all campaigns')
    : state.live.reportCampaigns.find((campaign) => campaign.id === job.campaign_id)?.name ?? t(state, 'حملة واحدة', 'one campaign');
  const text: Readonly<Record<ExportView, string>> = {
    queued: t(state, `ملف CSV في الطابور (${scope}).`, `CSV export queued (${scope}).`),
    running: t(state, `جارٍ تجهيز ملف CSV (${scope})…`, `Preparing the CSV export (${scope})…`),
    completed: t(state, `ملف CSV جاهز: ${formatNumber(job.row_count ?? 0, state.lang)} صف (${scope}).`, `CSV ready: ${formatNumber(job.row_count ?? 0, state.lang)} rows (${scope}).`),
    failed: t(state, 'تعذّر تجهيز الملف. أنشئ تصديرًا جديدًا.', 'The export failed. Start a new export.'),
    expired: t(state, 'انتهت صلاحية رابط التنزيل. أنشئ تصديرًا جديدًا.', 'The download link expired. Start a new export.'),
  };
  const tone: Readonly<Record<ExportView, 'info' | 'warning' | 'plain'>> = {
    queued: 'plain', running: 'plain', completed: 'info', failed: 'warning', expired: 'warning',
  };
  return h('div', { class: `export export--${view}`, 'data-export': view, role: 'status', 'aria-live': 'polite' }, [
    notice(
      tone[view],
      view === 'completed' ? 'check' : view === 'failed' || view === 'expired' ? 'alert' : 'clock',
      h('span', {}, [text[view]]),
      view === 'queued' || view === 'running' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
      view === 'completed' && job.download_url !== null
        ? h('a', { class: 'btn btn--sm btn--primary', href: job.download_url, download: '', 'data-export-ready': 'true' }, [icon('download', 14), t(state, 'تنزيل', 'Download')])
        : null,
      view === 'completed' ? h('span', { class: 'export__hint' }, [t(state, 'يتاح الرابط 24 ساعة.', 'The link is available for 24 hours.')]) : null,
      state.analyticsFilters.from !== '' || state.analyticsFilters.to !== '' || state.analyticsFilters.channel !== ''
        ? h('span', { class: 'export__hint' }, [t(state, 'يشمل الملف الحملة المختارة فقط؛ لا تُطبَّق الفترة والقناة عليه.', 'The file follows the campaign filter only; period and channel are not applied to it.')])
        : null,
    ),
  ]);
}
