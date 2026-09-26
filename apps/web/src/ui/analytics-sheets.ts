import type { CampaignReport, OperationalReport, ResolutionReport, ResponseReport, TeamReportRow, TimingChannelReportRow, TimingReportRow, AssignmentReportRow } from '../api/campaigns.js';
import type { AnalyticsView, AppState } from '../state.js';
import type { Cell, Sheet } from '../xlsx.js';
import { assignmentActionLabel, statusLabel } from './analytics-screen.js';
import { CAMPAIGN_STATES, CHANNEL_NAMES, ERROR_CODES, phrase, RECIPIENT_STATES, t } from './copy.js';

/**
 * Analytics as spreadsheet tables: every report the screen has loaded, one
 * table per chart or list, in the workspace's language. Durations are written
 * in minutes and shares as real percentages, so the numbers can be worked
 * with rather than only read.
 */

function minutes(seconds: number | null): Cell {
  return seconds === null ? null : Math.round(seconds / 6) / 10;
}

function ratio(value: number, total: number): Cell {
  return total <= 0 ? null : { ratio: Math.round((value / total) * 10000) / 10000 };
}

function channel(state: AppState, kind: string): string {
  return phrase(state, CHANNEL_NAMES, kind);
}

function min(state: AppState, ar: string, en: string): string {
  return t(state, `${ar} (دقيقة)`, `${en} (min)`);
}

function operationsSheets(state: AppState, report: OperationalReport): Sheet[] {
  const c = report.conversations;
  const tm = report.timing;
  return [
    { name: t(state, 'نظرة عامة', 'Overview'), rows: [
      [t(state, 'المقياس', 'Measure'), t(state, 'القيمة', 'Value')],
      [t(state, 'العمل المفتوح', 'Open workload'), c.open],
      [t(state, 'غير معيّن', 'Unassigned'), c.unassigned],
      [t(state, 'جديد في الفترة', 'New in period'), c.new],
      [t(state, 'إسنادات في الفترة', 'Assignments in period'), c.assignedInPeriod],
      [t(state, 'تم الحل', 'Resolved'), c.resolved],
      [t(state, 'رسائل بشرية', 'Human messages'), c.humanMessages],
      [t(state, 'ملاحظات داخلية', 'Internal notes'), c.internalNotes],
      [t(state, 'إعادات إسناد', 'Reassignments'), c.reassignments],
      [t(state, 'أول ردود مقاسة', 'First responses measured'), tm.firstResponseMeasured],
      [min(state, 'متوسط أول رد', 'Avg. first response'), minutes(tm.firstResponseAverageSeconds)],
      [min(state, 'وسيط أول رد', 'Median first response'), minutes(tm.firstResponseMedianSeconds)],
      [t(state, 'حلول مقاسة', 'Resolutions measured'), tm.resolutionMeasured],
      [min(state, 'متوسط الحل', 'Avg. resolution'), minutes(tm.resolutionAverageSeconds)],
      [min(state, 'وسيط الحل', 'Median resolution'), minutes(tm.resolutionMedianSeconds)],
      [t(state, 'آخر تحديث (UTC)', 'Updated (UTC)'), report.generatedAt],
    ] },
    { name: t(state, 'العمل حسب الحالة', 'Workload by status'), rows: [
      [t(state, 'الحالة', 'Status'), t(state, 'المحادثات', 'Conversations'), t(state, 'النسبة', 'Share')],
      ...c.backlogByStatus.map((row) => [statusLabel(state, row.status), row.count, ratio(row.count, total(c.backlogByStatus))]),
    ] },
    { name: t(state, 'العمل حسب القناة', 'Workload by channel'), rows: [
      [t(state, 'القناة', 'Channel'), t(state, 'المحادثات', 'Conversations'), t(state, 'النسبة', 'Share')],
      ...c.backlogByChannel.map((row) => [channel(state, row.channel), row.count, ratio(row.count, total(c.backlogByChannel))]),
    ] },
    { name: t(state, 'العمل حسب الفريق', 'Workload by team'), rows: [
      [t(state, 'الفريق', 'Team'), t(state, 'المحادثات', 'Conversations')],
      ...c.backlogByTeam.map((row) => [row.team, row.count]),
    ] },
    { name: t(state, 'حمل التعيين', 'Assignment workload'), rows: [
      [t(state, 'الوكيل', 'Agent'), t(state, 'المحادثات', 'Conversations')],
      ...c.assignmentWorkload.map((row) => [row.name, row.count]),
    ] },
    { name: t(state, 'توزيع زمن أول رد', 'First-response buckets'), rows: [
      [t(state, 'المدة', 'Duration'), t(state, 'العدد', 'Count')],
      ...report.responseBuckets.map((row) => [row.bucket, row.count]),
    ] },
    channelSheet(state, report),
    agentSheet(state, report),
  ];
}

function total(rows: readonly { readonly count: number }[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function channelSheet(state: AppState, report: OperationalReport): Sheet {
  return { name: t(state, 'أداء القنوات', 'Channel performance'), rows: [
    [t(state, 'القناة', 'Channel'), t(state, 'نشط الآن', 'Active now'), t(state, 'جديد', 'New'), t(state, 'تم التعامل', 'Handled'),
      t(state, 'رسائل بشرية', 'Human messages'), t(state, 'أول رد', 'First responses'), min(state, 'متوسط أول رد', 'Avg. first response'),
      min(state, 'وسيط أول رد', 'Median first response'), t(state, 'الحلول', 'Resolved'), min(state, 'متوسط الحل', 'Avg. resolution'), min(state, 'وسيط الحل', 'Median resolution')],
    ...report.channels.map((row) => [channel(state, row.channel), row.currentActive, row.newConversations, row.handledConversations, row.humanMessages,
      row.firstResponses, minutes(row.firstResponseAverageSeconds), minutes(row.firstResponseMedianSeconds), row.resolutions,
      minutes(row.resolutionAverageSeconds), minutes(row.resolutionMedianSeconds)]),
  ] };
}

function agentSheet(state: AppState, report: OperationalReport): Sheet {
  return { name: t(state, 'الوكلاء', 'Agents'), rows: [
    [t(state, 'الوكيل', 'Agent'), t(state, 'البريد', 'Email'), t(state, 'الفرق', 'Teams'), t(state, 'مُسند الآن', 'Current assigned'), t(state, 'مفتوح', 'Open'),
      t(state, 'بانتظار العميل', 'Pending'), t(state, 'مؤجل', 'Snoozed'), t(state, 'بلا رد بشري', 'Unreplied'), t(state, 'أُسند في الفترة', 'Assigned in period'),
      t(state, 'تم التعامل', 'Handled'), t(state, 'رسائل بشرية', 'Human messages'), t(state, 'ملاحظات', 'Notes'), t(state, 'أول رد', 'First responses'),
      min(state, 'متوسط أول رد', 'Avg. first response'), min(state, 'وسيط أول رد', 'Median first response'), t(state, 'حلول', 'Resolved'),
      min(state, 'متوسط الحل', 'Avg. resolution'), min(state, 'وسيط الحل', 'Median resolution'), t(state, 'إعادات إسناد', 'Reassignments')],
    ...report.agents.map((agent) => [agent.name, agent.email, agent.teams.join(', '), agent.currentAssigned, agent.currentOpen, agent.currentPending,
      agent.currentSnoozed, agent.currentUnreplied, agent.assignedInPeriod, agent.handledConversations, agent.humanMessages, agent.internalNotes,
      agent.firstResponses, minutes(agent.firstResponseAverageSeconds), minutes(agent.firstResponseMedianSeconds), agent.resolutions,
      minutes(agent.resolutionAverageSeconds), minutes(agent.resolutionMedianSeconds), agent.reassignments]),
  ] };
}

function teamSheet(state: AppState, rows: readonly TeamReportRow[]): Sheet {
  return { name: t(state, 'الفرق', 'Teams'), rows: [
    [t(state, 'الفريق', 'Team'), t(state, 'الوكلاء النشطون', 'Active agents'), t(state, 'النشط الآن', 'Current active'), t(state, 'مفتوح', 'Open'),
      t(state, 'معلّق', 'Pending'), t(state, 'مؤجل', 'Snoozed'), t(state, 'تم التعامل', 'Handled'), t(state, 'رسائل بشرية', 'Human messages'),
      t(state, 'أول رد', 'First responses'), min(state, 'متوسط أول رد', 'Avg. first response'), min(state, 'وسيط أول رد', 'Median first response'),
      t(state, 'الحلول', 'Resolutions'), min(state, 'متوسط الحل', 'Avg. resolution'), min(state, 'وسيط الحل', 'Median resolution')],
    ...rows.map((row) => [row.name, row.activeAgentCount, row.currentActive, row.currentOpen, row.currentPending, row.currentSnoozed,
      row.handledConversations, row.humanMessages, row.firstResponses, minutes(row.firstResponseAverageSeconds), minutes(row.firstResponseMedianSeconds),
      row.resolutions, minutes(row.resolutionAverageSeconds), minutes(row.resolutionMedianSeconds)]),
  ] };
}

function timingSheets(state: AppState, prefix: readonly [string, string], byAgent: readonly TimingReportRow[], byChannel: readonly TimingChannelReportRow[]): Sheet[] {
  const head = (first: string): Cell[] => [first, t(state, 'مقاس', 'Measured'), min(state, 'المتوسط', 'Average'), min(state, 'الوسيط', 'Median')];
  return [
    { name: t(state, `${prefix[0]} حسب الوكيل`, `${prefix[1]} by agent`), rows: [head(t(state, 'الوكيل', 'Agent')),
      ...byAgent.map((row) => [row.name, row.measured, minutes(row.averageSeconds), minutes(row.medianSeconds)])] },
    { name: t(state, `${prefix[0]} حسب القناة`, `${prefix[1]} by channel`), rows: [head(t(state, 'القناة', 'Channel')),
      ...byChannel.map((row) => [channel(state, row.channel), row.measured, minutes(row.averageSeconds), minutes(row.medianSeconds)])] },
  ];
}

function responseSheets(state: AppState, report: ResponseReport): Sheet[] {
  return [
    { name: t(state, 'أول رد', 'First responses'), rows: [
      [t(state, 'المقياس', 'Measure'), t(state, 'القيمة', 'Value')],
      [t(state, 'استجابات مقاسة', 'Measured responses'), report.measured],
      [min(state, 'المتوسط', 'Average'), minutes(report.averageSeconds)],
      [min(state, 'الوسيط', 'Median'), minutes(report.medianSeconds)],
    ] },
    { name: t(state, 'توزيع زمن أول رد', 'First-response buckets'), rows: [
      [t(state, 'المدة', 'Duration'), t(state, 'العدد', 'Count')],
      ...report.buckets.map((row) => [row.bucket, row.count]),
    ] },
    ...timingSheets(state, ['الردود', 'Responses'], report.byAgent, report.byChannel),
  ];
}

function resolutionSheets(state: AppState, report: ResolutionReport): Sheet[] {
  return [
    { name: t(state, 'الحلول', 'Resolutions'), rows: [
      [t(state, 'المقياس', 'Measure'), t(state, 'القيمة', 'Value')],
      [t(state, 'حلقات محلولة', 'Resolved episodes'), report.resolvedEpisodes],
      [t(state, 'حلقات أعيد فتحها', 'Reopened episodes'), report.reopenedEpisodes],
      [t(state, 'حُلّت من أول مرة', 'Solved the first time'), ratio(report.resolvedEpisodes - report.reopenedEpisodes, report.resolvedEpisodes)],
      [min(state, 'المتوسط', 'Average'), minutes(report.averageSeconds)],
      [min(state, 'الوسيط', 'Median'), minutes(report.medianSeconds)],
    ] },
    ...timingSheets(state, ['الحلول', 'Resolutions'], report.byAgent, report.byChannel),
  ];
}

function assignmentSheet(state: AppState, rows: readonly AssignmentReportRow[]): Sheet {
  return { name: t(state, 'الإسنادات', 'Assignments'), rows: [
    [t(state, 'الوقت (UTC)', 'Time (UTC)'), t(state, 'المحادثة', 'Conversation'), t(state, 'العميل', 'Customer'), t(state, 'الإجراء', 'Action'),
      t(state, 'من', 'From'), t(state, 'إلى', 'To'), t(state, 'بواسطة', 'Actor')],
    ...rows.map((row) => [row.timestamp, row.conversationId, row.customer, assignmentActionLabel(state, row.action),
      row.previousAssignee?.displayName ?? t(state, 'غير معيّن', 'Unassigned'), row.assignedTo.displayName, row.actor?.displayName ?? t(state, 'النظام', 'System')]),
  ] };
}

function campaignSheets(state: AppState, report: CampaignReport): Sheet[] {
  const m = report.milestones;
  const cur = report.current;
  const states = ['planned', 'queued', 'in_flight', 'accepted', 'delivered', 'read', 'failed', 'skipped', 'cancelled', 'outcome_unknown'] as const;
  return [
    { name: t(state, 'ملخص الحملات', 'Campaign summary'), rows: [
      [t(state, 'المقياس', 'Measure'), t(state, 'القيمة', 'Value')],
      [t(state, 'الحملات', 'Campaigns'), report.definitions.campaigns],
      [t(state, 'التنفيذات', 'Executions'), report.definitions.executions],
      [t(state, 'الجمهور', 'Audience'), report.audience.denominator],
      [t(state, 'المؤهلون', 'Eligible'), report.audience.eligible],
      [t(state, 'المستبعدون', 'Excluded'), report.audience.excluded],
      [t(state, 'المستلمون', 'Recipients'), m.denominator],
      [t(state, 'أُرسلت', 'Sent'), m.accepted],
      [t(state, 'سُلّمت', 'Delivered'), m.delivered],
      [t(state, 'قُرئت', 'Read'), m.read],
      [t(state, 'فشلت', 'Failed'), cur.failed],
      [t(state, 'نسبة الإرسال', 'Sent rate'), ratio(m.accepted, m.denominator)],
      [t(state, 'نسبة التسليم', 'Delivery rate'), ratio(m.delivered, m.denominator)],
      [t(state, 'نسبة القراءة', 'Read rate'), ratio(m.read, m.denominator)],
      [t(state, 'نسبة الفشل', 'Failure rate'), ratio(cur.failed, cur.denominator)],
      [t(state, 'البيانات حتى (UTC)', 'Data through (UTC)'), report.fresh_through],
    ] },
    { name: t(state, 'مسار التسليم', 'Delivery funnel'), rows: [
      [t(state, 'المرحلة', 'Stage'), t(state, 'العدد', 'Count'), t(state, 'من المستلمين', 'Of recipients'), t(state, 'من المرحلة السابقة', 'Of previous step')],
      [t(state, 'المستلمون', 'Recipients'), m.denominator, ratio(m.denominator, m.denominator), null],
      [t(state, 'أُرسلت', 'Sent'), m.accepted, ratio(m.accepted, m.denominator), ratio(m.accepted, m.denominator)],
      [t(state, 'سُلّمت', 'Delivered'), m.delivered, ratio(m.delivered, m.denominator), ratio(m.delivered, m.accepted)],
      [t(state, 'قُرئت', 'Read'), m.read, ratio(m.read, m.denominator), ratio(m.read, m.delivered)],
    ] },
    { name: t(state, 'الحالة الحالية', 'Current state'), rows: [
      [t(state, 'الحالة', 'State'), t(state, 'المستلمون', 'Recipients'), t(state, 'النسبة', 'Share')],
      ...states.map((key) => [phrase(state, RECIPIENT_STATES, key), cur[key], ratio(cur[key], cur.denominator)]),
    ] },
    { name: t(state, 'الحملات', 'Campaigns'), rows: [
      [t(state, 'الحملة', 'Campaign'), t(state, 'الحالة', 'State'), t(state, 'المستلمون', 'Recipients'), t(state, 'مشمول', 'Included'), t(state, 'مستبعد', 'Excluded'),
        t(state, 'أُرسلت', 'Sent'), t(state, 'سُلّمت', 'Delivered'), t(state, 'قُرئت', 'Read'), t(state, 'فشلت', 'Failed'), t(state, 'غير معروفة', 'Unknown'),
        t(state, 'قيد الانتظار', 'Waiting'), t(state, 'نسبة التسليم', 'Delivery rate'), t(state, 'نسبة القراءة', 'Read rate'), t(state, 'آخر تحديث (UTC)', 'Updated (UTC)')],
      ...report.campaigns.map((row) => [row.name, phrase(state, CAMPAIGN_STATES, row.state), row.denominator, row.included, row.excluded, row.accepted,
        row.delivered, row.read, row.failed, row.outcome_unknown, row.pending, ratio(row.delivered, row.denominator), ratio(row.read, row.denominator), row.fresh_through]),
    ] },
    { name: t(state, 'الحملات حسب القناة', 'Campaigns by channel'), rows: [
      [t(state, 'القناة', 'Channel'), t(state, 'المستلمون', 'Recipients'), t(state, 'أُرسلت', 'Sent'), t(state, 'سُلّمت', 'Delivered'), t(state, 'قُرئت', 'Read'),
        t(state, 'نسبة التسليم', 'Delivery rate'), t(state, 'نسبة القراءة', 'Read rate')],
      ...report.channels.map((row) => [channel(state, row.kind), row.denominator, row.accepted,
        row.delivery_receipts ? row.delivered : null, row.read_receipts ? row.read : null,
        row.delivery_receipts ? ratio(row.delivered, row.denominator) : null, row.read_receipts ? ratio(row.read, row.denominator) : null]),
    ] },
    { name: t(state, 'أسباب الفشل', 'Failure reasons'), rows: [
      [t(state, 'السبب', 'Reason'), t(state, 'الرمز', 'Code'), t(state, 'العدد', 'Count'), t(state, 'النسبة', 'Share')],
      ...report.errors.map((row) => [phrase(state, ERROR_CODES, row.code), row.code, row.count, ratio(row.count, total(report.errors))]),
    ] },
    { name: t(state, 'الحجم اليومي', 'Daily volume'), rows: [
      [t(state, 'اليوم', 'Day'), t(state, 'المستلمون', 'Recipients'), t(state, 'أُرسلت', 'Sent'), t(state, 'سُلّمت', 'Delivered'), t(state, 'قُرئت', 'Read'),
        t(state, 'فشلت', 'Failed'), t(state, 'نسبة التسليم', 'Delivery rate')],
      ...report.trend.map((day) => [day.day, day.recipients, day.accepted, day.delivered, day.read, day.failed, ratio(day.delivered, day.recipients)]),
    ] },
    ...(report.costs.length === 0 ? [] : [{ name: t(state, 'التكلفة', 'Cost'), rows: [
      [t(state, 'العملة', 'Currency'), t(state, 'مقدّرة', 'Estimated'), t(state, 'محجوزة', 'Committed'), t(state, 'مطابقة مع المزوّد', 'Reconciled')],
      ...report.costs.map((cost) => [cost.currency, cost.estimated_amount_minor, cost.committed_amount_minor, cost.reconciled_amount_minor]),
    ] }]),
  ];
}

/** The tables behind one analytics view, from whatever of it has loaded. */
export function sheetsFor(state: AppState, view: AnalyticsView): Sheet[] {
  const live = state.live;
  const operations = live.operationalReport.status === 'ready' ? live.operationalReport.value : null;
  if (view === 'overview') return operations === null ? [] : operationsSheets(state, operations);
  if (view === 'agents') return operations === null ? [] : [agentSheet(state, operations)];
  if (view === 'channels') return operations === null ? [] : [channelSheet(state, operations)];
  if (view === 'teams') return live.teamReport.status === 'ready' ? [teamSheet(state, live.teamReport.value)] : [];
  if (view === 'responses') return live.responseReport.status === 'ready' ? responseSheets(state, live.responseReport.value) : [];
  if (view === 'resolutions') return live.resolutionReport.status === 'ready' ? resolutionSheets(state, live.resolutionReport.value) : [];
  if (view === 'assignments') return live.assignmentReport.status === 'ready' ? [assignmentSheet(state, live.assignmentReport.value)] : [];
  return live.campaignReport.status === 'ready' ? campaignSheets(state, live.campaignReport.value) : [];
}

/** Every loaded report, campaigns first, each table once. */
export function allSheets(state: AppState): Sheet[] {
  return (['campaigns', 'overview', 'teams', 'responses', 'resolutions', 'assignments'] as const).flatMap((view) => sheetsFor(state, view));
}
