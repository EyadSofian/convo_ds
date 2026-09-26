/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { CampaignReport, OperationalReport, TeamReportRow } from '../api/campaigns';
import { createState } from '../state';
import type { AppState } from '../state';
import { allSheets, sheetsFor } from './analytics-sheets';

/**
 * The spreadsheet tables are the same figures the charts draw: minutes for
 * durations, real shares for percentages, and nothing for a share of nothing.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

function campaign(overrides: Partial<CampaignReport> = {}): CampaignReport {
  return {
    generated_at: NOW.toISOString(), fresh_through: '2026-09-09T09:15:00.000Z', timezone: 'UTC',
    filters: { from: null, to: null, channel: null, campaign_id: null },
    definitions: { campaigns: 2, executions: 1 },
    audience: { denominator: 1920, eligible: 1764, excluded: 156 },
    current: { denominator: 618, planned: 38, queued: 42, in_flight: 8, accepted: 101, delivered: 214, read: 187, failed: 19, skipped: 7, cancelled: 0, outcome_unknown: 2 },
    milestones: { denominator: 618, accepted: 502, delivered: 401, read: 187 },
    costs: [{ currency: 'USD', estimated_amount_minor: '30.9', committed_amount_minor: '25.2', reconciled_amount_minor: '24.6' }],
    channels: [
      { kind: 'whatsapp', denominator: 500, accepted: 420, delivered: 358, read: 170, delivery_receipts: true, read_receipts: true },
      { kind: 'instagram', denominator: 118, accepted: 82, delivered: 43, read: 17, delivery_receipts: false, read_receipts: false },
    ],
    errors: [{ code: 'provider_rejected', count: 12 }, { code: 'brand_new_code', count: 7 }],
    trend: [{ day: '2026-09-05', recipients: 96, accepted: 81, delivered: 66, read: 34, failed: 3 }, { day: '2026-09-06', recipients: 0, accepted: 0, delivered: 0, read: 0, failed: 0 }],
    campaigns: [
      { id: 'c-1', name: 'Reminder', state: 'running', denominator: 618, pending: 88, accepted: 502, delivered: 401, read: 187, failed: 19, outcome_unknown: 2, included: 618, excluded: 22, fresh_through: NOW.toISOString() },
      { id: 'c-2', name: 'Autumn intake', state: 'ready', denominator: 0, pending: 0, accepted: 0, delivered: 0, read: 0, failed: 0, outcome_unknown: 0, included: null, excluded: null, fresh_through: NOW.toISOString() },
    ],
    ...overrides,
  };
}

function operations(): OperationalReport {
  return {
    generatedAt: NOW.toISOString(), filters: { from: null, to: null, agentId: null, teamId: null, channel: null, connectionId: null, labelId: null, campaignId: null, priority: null, status: null },
    agentOptions: [],
    conversations: {
      open: 7, unassigned: 1, new: 4, resolved: 3, assignedInPeriod: 5, humanMessages: 12, internalNotes: 2, reassignments: 1,
      backlogByStatus: [{ status: 'open', count: 5 }, { status: 'pending', count: 2 }],
      backlogByChannel: [{ channel: 'whatsapp', count: 7 }],
      backlogByTeam: [{ team: 'Support', count: 7 }],
      assignmentWorkload: [{ name: 'Mona Agent', count: 7 }],
    },
    timing: { firstResponseMeasured: 4, firstResponseAverageSeconds: 75, firstResponseMedianSeconds: null, resolutionMeasured: 3, resolutionAverageSeconds: 300, resolutionMedianSeconds: 280 },
    responseBuckets: [{ bucket: '<5m', count: 1 }],
    channels: [{ channel: 'whatsapp', currentActive: 7, newConversations: 4, handledConversations: 3, humanMessages: 5, firstResponses: 4, firstResponseAverageSeconds: 75, firstResponseMedianSeconds: 70, resolutions: 3, resolutionAverageSeconds: 300, resolutionMedianSeconds: 280 }],
    agents: [{
      membershipId: 'm-1', name: 'Mona Agent', email: 'mona@example.test', teams: ['Support', 'Sales'],
      currentAssigned: 7, currentOpen: 5, currentPending: 2, currentSnoozed: 0, currentUnreplied: 1, currentUrgent: 0, currentHigh: 1,
      currentByStatus: [], currentByChannel: [], assignedInPeriod: 4, handledConversations: 3, humanMessages: 5, internalNotes: 2,
      firstResponses: 4, firstResponseAverageSeconds: 75, firstResponseMedianSeconds: 70, resolutions: 3, resolutionAverageSeconds: 300, resolutionMedianSeconds: 280, reassignments: 1,
    }],
  };
}

const TEAM: TeamReportRow = {
  teamId: 't-1', name: 'Support', activeAgentCount: 2, currentActive: 5, currentOpen: 3, currentPending: 1, currentSnoozed: 1,
  handledConversations: 4, humanMessages: 9, firstResponses: 2, firstResponseAverageSeconds: 60, firstResponseMedianSeconds: 55,
  resolutions: 1, resolutionAverageSeconds: 400, resolutionMedianSeconds: 400,
};

function loaded(lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  state.live.campaignReport = { status: 'ready', loadedAt: 1, value: campaign() };
  state.live.operationalReport = { status: 'ready', loadedAt: 1, value: operations() };
  state.live.teamReport = { status: 'ready', loadedAt: 1, value: [TEAM] };
  state.live.responseReport = { status: 'ready', loadedAt: 1, value: {
    measured: 4, averageSeconds: 75, medianSeconds: 70, buckets: [{ bucket: '<5m', count: 4 }],
    byAgent: [{ membershipId: 'm-1', name: 'Mona Agent', measured: 4, averageSeconds: 75, medianSeconds: 70 }],
    byChannel: [{ channel: 'whatsapp', measured: 4, averageSeconds: 75, medianSeconds: 70 }],
  } };
  state.live.resolutionReport = { status: 'ready', loadedAt: 1, value: {
    resolvedEpisodes: 4, averageSeconds: 300, medianSeconds: 280, reopenedEpisodes: 1, byAgent: [], byChannel: [],
  } };
  state.live.assignmentReport = { status: 'ready', loadedAt: 1, value: [
    { id: 'a-1', timestamp: NOW.toISOString(), conversationId: 'c-1', customer: 'Mona', action: 'handoff', previousAssignee: { membershipId: 'm-2', displayName: 'Ahmed' }, assignedTo: { membershipId: 'm-1', displayName: 'Sara' }, actor: null },
    { id: 'a-2', timestamp: NOW.toISOString(), conversationId: 'c-2', customer: null, action: 'claim', previousAssignee: null, assignedTo: { membershipId: 'm-1', displayName: 'Sara' }, actor: { membershipId: 'm-1', displayName: 'Sara' } },
  ] };
  return state;
}

function names(state: AppState, view: Parameters<typeof sheetsFor>[1]): string[] {
  return sheetsFor(state, view).map((sheet) => sheet.name);
}

describe('the tables behind each view', () => {
  it('turns the campaign report into its summary, funnel, states, campaigns, channels, reasons, days and cost', () => {
    const sheets = sheetsFor(loaded(), 'campaigns');
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      'Campaign summary', 'Delivery funnel', 'Current state', 'Campaigns', 'Campaigns by channel', 'Failure reasons', 'Daily volume', 'Cost',
    ]);
    const summary = sheets[0]?.rows ?? [];
    expect(summary).toContainEqual(['Delivery rate', { ratio: 0.6489 }]);
    expect(summary).toContainEqual(['Data through (UTC)', '2026-09-09T09:15:00.000Z']);
    expect(sheets[1]?.rows[1]).toEqual(['Recipients', 618, { ratio: 1 }, null]);
    expect(sheets[3]?.rows[2]).toEqual(['Autumn intake', 'Ready', 0, null, null, 0, 0, 0, 0, 0, 0, null, null, NOW.toISOString()]);
    // A channel that does not report reads has no read figure, not a zero.
    expect(sheets[4]?.rows[2]).toEqual(['Instagram', 118, 82, null, null, null, null]);
    expect(sheets[5]?.rows[2]).toEqual(['brand_new_code', 'brand_new_code', 7, { ratio: 0.3684 }]);
    expect(sheets[6]?.rows[2]).toEqual(['2026-09-06', 0, 0, 0, 0, 0, null]);
    const noCost = loaded();
    noCost.live.campaignReport = { status: 'ready', loadedAt: 1, value: campaign({ costs: [] }) };
    expect(names(noCost, 'campaigns')).not.toContain('Cost');
  });

  it('writes the operations overview with durations in minutes and each breakdown as its own table', () => {
    const sheets = sheetsFor(loaded(), 'overview');
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      'Overview', 'Workload by status', 'Workload by channel', 'Workload by team', 'Assignment workload', 'First-response buckets', 'Channel performance', 'Agents',
    ]);
    expect(sheets[0]?.rows).toContainEqual(['Avg. first response (min)', 1.3]);
    expect(sheets[0]?.rows).toContainEqual(['Median first response (min)', null]);
    expect(sheets[1]?.rows[1]).toEqual(['Open', 5, { ratio: 0.7143 }]);
    expect(sheets[7]?.rows[1]?.slice(0, 3)).toEqual(['Mona Agent', 'mona@example.test', 'Support, Sales']);
    expect(names(loaded(), 'agents')).toEqual(['Agents']);
    expect(names(loaded(), 'channels')).toEqual(['Channel performance']);
  });

  it('writes teams, responses, resolutions and the ownership log', () => {
    expect(sheetsFor(loaded(), 'teams')[0]?.rows[1]?.slice(0, 3)).toEqual(['Support', 2, 5]);
    expect(names(loaded(), 'responses')).toEqual(['First responses', 'First-response buckets', 'Responses by agent', 'Responses by channel']);
    const resolutions = sheetsFor(loaded(), 'resolutions');
    expect(resolutions.map((sheet) => sheet.name)).toEqual(['Resolutions', 'Resolutions by agent', 'Resolutions by channel']);
    expect(resolutions[0]?.rows).toContainEqual(['Solved the first time', { ratio: 0.75 }]);
    const log = sheetsFor(loaded(), 'assignments')[0]?.rows ?? [];
    expect(log[1]).toEqual([NOW.toISOString(), 'c-1', 'Mona', 'Handoff', 'Ahmed', 'Sara', 'System']);
    expect(log[2]).toEqual([NOW.toISOString(), 'c-2', null, 'Claim', 'Unassigned', 'Sara', 'Sara']);
  });

  it('has nothing for a report that has not loaded', () => {
    const state = createState(NOW);
    for (const view of ['campaigns', 'overview', 'agents', 'channels', 'teams', 'responses', 'resolutions', 'assignments'] as const) {
      expect(sheetsFor(state, view)).toEqual([]);
    }
    expect(allSheets(state)).toEqual([]);
  });

  it('gathers every report, campaigns first, in Arabic when the workspace reads Arabic', () => {
    const sheets = allSheets(loaded('ar'));
    expect(sheets[0]?.name).toBe('ملخص الحملات');
    expect(sheets.map((sheet) => sheet.name)).toContain('الإسنادات');
    expect(sheets.map((sheet) => sheet.name)).toContain('الفرق');
    expect(sheets.find((sheet) => sheet.name === 'نظرة عامة')?.rows[0]).toEqual(['المقياس', 'القيمة']);
    expect(sheets).toHaveLength(8 + 8 + 1 + 4 + 3 + 1);
  });
});
