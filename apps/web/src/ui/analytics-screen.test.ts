/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { CampaignReport, CampaignReportExport, OperationalReport, TeamReportRow } from '../api/campaigns';
import { createState, NO_ANALYTICS_FILTERS } from '../state';
import { parseHash } from '../router.js';
import type { AppState } from '../state';
import { exportView, renderAnalytics } from './analytics-screen';

/**
 * Analytics. What is under test is honesty: every percentage names its
 * denominator, a metric the report does not carry is labelled as such, and the
 * export's state is whatever the server last said.
 */

const NOW = new Date('2026-09-09T09:30:00.000Z');

function report(overrides: Partial<CampaignReport> = {}): CampaignReport {
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
    trend: [
      { day: '2026-09-05', recipients: 96, accepted: 81, delivered: 66, read: 34, failed: 3 },
      { day: '2026-09-06', recipients: 0, accepted: 0, delivered: 0, read: 0, failed: 0 },
      { day: '2026-09-07', recipients: 522, accepted: 421, delivered: 335, read: 153, failed: 16 },
    ],
    campaigns: [
      { id: 'c-1', name: 'Reminder', state: 'running', denominator: 618, pending: 88, accepted: 502, delivered: 401, read: 187, failed: 19, outcome_unknown: 2, included: 618, excluded: 22, fresh_through: NOW.toISOString() },
      { id: 'c-2', name: 'Autumn intake', state: 'ready', denominator: 0, pending: 0, accepted: 0, delivered: 0, read: 0, failed: 0, outcome_unknown: 0, included: null, excluded: null, fresh_through: NOW.toISOString() },
    ],
    ...overrides,
  };
}

function screen(value: CampaignReport | null = report(), lang: 'ar' | 'en' = 'en'): AppState {
  const state = createState(NOW);
  state.lang = lang;
  state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
  state.route = { screen: 'analytics', conversationId: null, params: {} };
  state.live.campaignReport = value === null ? { status: 'loading' } : { status: 'ready', loadedAt: 1, value };
  state.live.reportCampaigns = [{ id: 'c-1', name: 'Reminder' }, { id: 'c-2', name: 'Autumn intake' }];
  return state;
}

function exportJob(overrides: Partial<CampaignReportExport> = {}): CampaignReportExport {
  return {
    id: 'x-1', campaign_id: null, format: 'csv', state: 'queued', row_count: null, error_code: null,
    requested_at: NOW.toISOString(), completed_at: null, expires_at: null, download_url: null, ...overrides,
  };
}

function operations(): OperationalReport {
  return {
    generatedAt: NOW.toISOString(), filters: { from: null, to: null, agentId: null, teamId: null, channel: null, connectionId: null, labelId: null, campaignId: null, priority: null, status: null },
    agentOptions: [{ membershipId: '00000000-0000-4000-8000-000000000001', name: 'Mona Agent', teams: ['Support'] }],
    conversations: {
      open: 7, unassigned: 1, new: 4, resolved: 3, assignedInPeriod: 5, humanMessages: 12, internalNotes: 2, reassignments: 1,
      backlogByStatus: [{ status: 'open', count: 5 }, { status: 'pending', count: 2 }],
      backlogByChannel: [{ channel: 'website_chat', count: 7 }],
      backlogByTeam: [{ team: 'Support', count: 7 }],
      assignmentWorkload: [{ name: 'Mona Agent', count: 7 }],
    },
    timing: { firstResponseMeasured: 4, firstResponseAverageSeconds: 75, firstResponseMedianSeconds: 70, resolutionMeasured: 3, resolutionAverageSeconds: 300, resolutionMedianSeconds: 280 },
    responseBuckets: [{ bucket: '<5m', count: 1 }, { bucket: '5–15m', count: 2 }, { bucket: '>60m', count: 1 }],
    channels: [{ channel: 'website_chat', currentActive: 7, newConversations: 4, handledConversations: 3, humanMessages: 5, firstResponses: 4, firstResponseAverageSeconds: 75, firstResponseMedianSeconds: 70, resolutions: 3, resolutionAverageSeconds: 300, resolutionMedianSeconds: 280 }],
    agents: [{
      membershipId: '00000000-0000-4000-8000-000000000001', name: 'Mona Agent', email: 'mona@example.test', teams: ['Support'],
      currentAssigned: 7, currentOpen: 5, currentPending: 2, currentSnoozed: 0,
      currentUnreplied: 1, currentUrgent: 0, currentHigh: 1,
      currentByStatus: [{ status: 'open', count: 5 }, { status: 'pending', count: 2 }],
      currentByChannel: [{ channel: 'website_chat', count: 7 }],
      assignedInPeriod: 4, handledConversations: 3, humanMessages: 5, internalNotes: 2,
      firstResponses: 4, firstResponseAverageSeconds: 75, firstResponseMedianSeconds: 70,
      resolutions: 3, resolutionAverageSeconds: 300, resolutionMedianSeconds: 280, reassignments: 1,
    }],
  };
}

describe('the filter bar', () => {
  it('offers period, channel and campaign, plus refresh and a real export', () => {
    const root = renderAnalytics(screen());
    const bar = root.querySelector('.filterbar') as HTMLElement;
    expect(bar.getAttribute('role')).toBe('search');
    expect(bar.querySelectorAll('input[type="date"]')).toHaveLength(2);
    expect(Array.from(bar.querySelectorAll('select')[0]?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value'))).toEqual(['', 'whatsapp', 'instagram']);
    expect(Array.from(bar.querySelectorAll('select')[1]?.querySelectorAll('option') ?? []).map((option) => option.textContent)).toEqual(['All campaigns', 'Reminder', 'Autumn intake']);
    expect(bar.querySelector('[data-act="live-report-export"]')).not.toBeNull();
    expect(bar.querySelector('[data-act="live-report-filter-clear"]')).toBeNull();
  });

  it('keeps a chosen channel selectable after the report narrows, and offers to clear', () => {
    const state = screen(report({ channels: [] }));
    state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, from: '2026-09-01', to: '2026-09-09', channel: 'messenger' };
    const bar = renderAnalytics(state).querySelector('.filterbar') as HTMLElement;
    expect(Array.from(bar.querySelectorAll('select')[0]?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value'))).toEqual(['', 'messenger']);
    expect((bar.querySelector('input[type="date"]') as HTMLInputElement).getAttribute('max')).toBe('2026-09-09');
    expect(bar.querySelectorAll('input[type="date"]')[1]?.getAttribute('min')).toBe('2026-09-01');
    expect(bar.querySelector('[data-act="live-report-filter-clear"]')).not.toBeNull();
  });

  it('holds the controls while a report loads, and cannot export what has not arrived', () => {
    const root = renderAnalytics(screen(null));
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect((root.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    expect((root.querySelector('[data-act="live-report-export"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders server-backed operational filters and historical response buckets', () => {
    const state = screen();
    state.analyticsView = 'overview';
    state.live.operationalReport = { status: 'ready', loadedAt: 1, value: operations() };
    state.live.teams = { status: 'ready', loadedAt: 1, value: [{ id: 'team-1', name: 'Support', member_count: 1, archived: false, members: [] }] };
    state.live.workspaceLabels = { status: 'ready', loadedAt: 1, value: [{ id: 'label-1', name: 'VIP', color: '#123456', state: 'active', version: 1 }] };
    state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, agentId: '00000000-0000-4000-8000-000000000001', labelId: 'label-1' };
    const root = renderAnalytics(state);
    const bar = root.querySelector('.filterbar') as HTMLElement;
    expect(bar.querySelectorAll('select').length).toBeGreaterThanOrEqual(8);
    expect(bar.textContent).toContain('Mona Agent ×');
    expect(bar.textContent).toContain('VIP ×');
    expect(root.textContent).toContain('First-response distribution');
    expect(root.textContent).toContain('5–15m');
    state.analyticsView = 'agents';
    state.route = { ...state.route, params: { agent: '00000000-0000-4000-8000-000000000001' } };
    const detailed = renderAnalytics(state);
    const drilldown = detailed.querySelector('a[href*="/inbox"]') as HTMLAnchorElement;
    expect(JSON.parse(parseHash(drilldown.getAttribute('href') ?? '').params.filters ?? '[]')).toEqual([
      { key: 'assigned_agent_id', operator: 'eq', value: '00000000-0000-4000-8000-000000000001' },
      { key: 'status', operator: 'eq', value: 'open' },
    ]);
  });
});

describe('operational analytics', () => {
  it('uses the operational API projection and labels its durable evidence', () => {
    const state = screen();
    state.analyticsView = 'overview';
    state.live.operationalReport = { status: 'ready', loadedAt: 1, value: operations() };
    const root = renderAnalytics(state);
    expect(root.querySelector('[data-operations-report-ready]')).not.toBeNull();
    expect(root.textContent).toContain('Open workload');
    expect(root.textContent).toContain('Mona Agent');
    expect(root.textContent).toContain('recorded actors');
    expect(root.querySelector('[data-act="live-report-export"]')).toBeNull();
    expect(root.querySelector('[data-act="analytics-view"][data-arg="campaigns"]')).not.toBeNull();
  });

  it('renders the UUID-keyed agent report as a focused surface with timing and workload drilldowns', () => {
    const state = screen();
    state.analyticsView = 'agents';
    state.live.operationalReport = { status: 'ready', loadedAt: 1, value: operations() };
    const root = renderAnalytics(state);
    expect(root.querySelector('[data-agent-id="00000000-0000-4000-8000-000000000001"]')).not.toBeNull();
    expect(root.textContent).toContain('Median response');
    expect(root.textContent).toContain('Mona Agent');
    expect(root.textContent).not.toContain('Current team grouping.');
  });

  it('renders only team report identities and canonical team drill-down filters', () => {
    const state = screen();
    state.analyticsView = 'teams';
    state.live.operationalReport = { status: 'ready', loadedAt: 1, value: operations() };
    const row: TeamReportRow = {
      teamId: '00000000-0000-4000-8000-000000000010', name: 'Support', activeAgentCount: 2,
      currentActive: 5, currentOpen: 3, currentPending: 1, currentSnoozed: 1,
      handledConversations: 4, humanMessages: 9, firstResponses: 2, firstResponseAverageSeconds: 60,
      firstResponseMedianSeconds: 55, resolutions: 1, resolutionAverageSeconds: 400, resolutionMedianSeconds: 400,
    };
    state.live.teamReport = { status: 'ready', loadedAt: 1, value: [row] };
    const root = renderAnalytics(state);
    expect(root.querySelector('[data-team-id="00000000-0000-4000-8000-000000000010"]')).not.toBeNull();
    expect(root.textContent).toContain('Current team grouping');
    expect(root.textContent).toContain('Median resolution');
    const link = root.querySelector('a[href*="/inbox"]') as HTMLAnchorElement;
    expect(JSON.parse(parseHash(link.getAttribute('href') ?? '').params.filters ?? '[]')).toEqual([
      { key: 'team_id', operator: 'eq', value: row.teamId },
    ]);
  });
});

describe('assignment analytics', () => {
  it('renders a server-paged ownership log with a real conversation action and load-more state', () => {
    const state = screen();
    state.analyticsView = 'assignments';
    state.live.assignmentReport = { status: 'ready', loadedAt: 1, value: [{
      id: 'audit-1', timestamp: NOW.toISOString(), conversationId: 'conversation-1', customer: 'Mona', action: 'handoff',
      previousAssignee: { membershipId: 'member-a', displayName: 'Ahmed' },
      assignedTo: { membershipId: 'member-b', displayName: 'Sara' }, actor: null,
    }] };
    state.live.assignmentNextCursor = 'opaque-cursor';
    const root = renderAnalytics(state);
    expect(root.textContent).toContain('Ownership changes');
    expect(root.textContent).toContain('Handoff');
    expect(root.textContent).toContain('Ahmed');
    expect(root.textContent).toContain('Sara');
    expect(root.textContent).toContain('System');
    expect(root.querySelector('th[scope="col"]')?.textContent).toBe('Time');
    expect(root.querySelector('[data-act="live-inbox-open"][data-arg="conversation-1"]')).not.toBeNull();
    expect(root.querySelector('[data-act="live-assignments-more"]')).not.toBeNull();
  });

  it('does not display stale assignment rows while the active filter query is loading', () => {
    const state = screen();
    state.analyticsView = 'assignments';
    state.live.assignmentReport = { status: 'loading' };
    const root = renderAnalytics(state);
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(root.querySelector('[data-assignment-id]')).toBeNull();
  });
});

describe('lifecycle analytics', () => {
  it('renders measured response timing, all populated buckets, and attributed agents', () => {
    const state = screen();
    state.analyticsView = 'responses';
    state.live.responseReport = { status: 'ready', loadedAt: 1, value: {
      measured: 1, averageSeconds: 420, medianSeconds: 420,
      buckets: [{ bucket: '5–15m', count: 1 }],
      byAgent: [{ membershipId: 'member-a', name: 'Ahmed', measured: 1, averageSeconds: 420, medianSeconds: 420 }],
      byChannel: [{ channel: 'whatsapp', measured: 1, averageSeconds: 420, medianSeconds: 420 }],
    } };
    const root = renderAnalytics(state);
    expect(root.textContent).toContain('Measured responses');
    expect(root.textContent).toContain('5–15m');
    expect(root.textContent).toContain('Ahmed');
    expect(root.textContent).toContain('WhatsApp');
    expect(root.querySelector('[data-arg="responses"][aria-pressed="true"]')).not.toBeNull();
  });

  it('renders resolution episodes with explicit unattributed evidence and reopen definition', () => {
    const state = screen();
    state.analyticsView = 'resolutions';
    state.live.resolutionReport = { status: 'ready', loadedAt: 1, value: {
      resolvedEpisodes: 2, averageSeconds: 300, medianSeconds: 300, reopenedEpisodes: 1,
      byAgent: [{ membershipId: null, name: 'Unattributed', measured: 2, averageSeconds: 300, medianSeconds: 300 }],
      byChannel: [],
    } };
    const root = renderAnalytics(state);
    expect(root.textContent).toContain('Resolved episodes');
    expect(root.textContent).toContain('Reopened episodes');
    expect(root.textContent).toContain('Unattributed');
    expect(root.textContent).toContain('sequence is greater than 1');
  });

  it('keeps an unknown first-response actor visible as Unattributed', () => {
    const state = screen();
    state.analyticsView = 'responses';
    state.live.responseReport = { status: 'ready', loadedAt: 1, value: {
      measured: 1, averageSeconds: 10, medianSeconds: 10, buckets: [{ bucket: '<5m', count: 1 }],
      byAgent: [{ membershipId: null, name: 'Unattributed', measured: 1, averageSeconds: 10, medianSeconds: 10 }], byChannel: [],
    } };
    expect(renderAnalytics(state).textContent).toContain('Unattributed');
  });

  it('renders empty and failed lifecycle report states without inventing data', () => {
    const state = screen();
    state.analyticsView = 'responses';
    state.live.responseReport = { status: 'ready', loadedAt: 1, value: {
      measured: 0, averageSeconds: null, medianSeconds: null, buckets: [], byAgent: [], byChannel: [],
    } };
    expect(renderAnalytics(state).textContent).toContain('No measured responses');
    state.analyticsView = 'resolutions';
    state.live.resolutionReport = { status: 'error', error: { code: 'internal', message: 'Failed', requestId: 'r-10', status: 500, details: [] } };
    expect(renderAnalytics(state).textContent).toContain('r-10');
  });
});

describe('focused operational report screens', () => {
  it('renders the channel report with zero-safe timing values and drill-down rows', () => {
    const state = screen();
    state.analyticsView = 'channels';
    state.live.operationalReport = { status: 'ready', loadedAt: 1, value: operations() };
    const root = renderAnalytics(state);
    expect(root.textContent).toContain('Channel performance');
    expect(root.textContent).toContain('Website chat');
    const link = root.querySelector('[data-channel="website_chat"] a') as HTMLAnchorElement;
    expect(JSON.parse(parseHash(link.getAttribute('href') ?? '').params.filters ?? '[]')).toEqual([
      { key: 'channel', operator: 'eq', value: 'website_chat' },
    ]);
  });

  it('renders report loading and error states for the focused agent screen', () => {
    const state = screen();
    state.analyticsView = 'agents';
    state.live.operationalReport = { status: 'loading' };
    expect(renderAnalytics(state).querySelector('[aria-busy="true"]')).not.toBeNull();
    state.live.operationalReport = { status: 'error', error: { code: 'internal', message: 'Failed', requestId: 'r-11', status: 500, details: [] } };
    expect(renderAnalytics(state).textContent).toContain('r-11');
  });
});

describe('a failed report', () => {
  it('says what failed with its request id, and offers a retry', () => {
    const state = screen(null);
    state.live.campaignReport = { status: 'error', error: { code: 'internal', message: 'Broke', requestId: 'r-9', status: 500, details: [] } };
    const root = renderAnalytics(state);
    expect(root.textContent).toContain('r-9');
    expect(root.querySelector('.errorstate [data-act="live-report-reload"]')).not.toBeNull();
    state.live.campaignReport = { status: 'idle' };
    expect(renderAnalytics(state).querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

describe('the report', () => {
  it('publishes its freshness and the denominator every percentage uses', () => {
    const root = renderAnalytics(screen());
    expect(root.querySelector('[data-report-ready]')?.textContent).toContain('percentages of 618 recipients');
    expect(root.querySelector('[data-report-ready]')?.textContent).toContain('UTC');
  });

  it('shows the KPI strip, with replies labelled as not measured rather than zero', () => {
    const root = renderAnalytics(screen());
    const kpis = Array.from(root.querySelectorAll('.kpi')).map((kpi) => kpi.querySelector('.kpi__label')?.textContent);
    expect(kpis).toEqual(['Audience', 'Recipients', 'Sent', 'Delivered', 'Read', 'Failed', 'Replies']);
    const replies = root.querySelectorAll('.kpi')[6] as HTMLElement;
    expect(replies.className).toContain('kpi--unavailable');
    expect(replies.textContent).toContain('Not measured');
    expect(root.querySelectorAll('.kpi')[5]?.className).toContain('kpi--danger');
    expect(root.querySelectorAll('.kpi')[2]?.textContent).toContain('81.2% of recipients');
  });

  it('draws the funnel against one denominator, and each step against the one before', () => {
    const root = renderAnalytics(screen());
    const stages = Array.from(root.querySelectorAll('.funnel__stage'));
    expect(stages).toHaveLength(5);
    expect(stages[0]?.textContent).toContain('Denominator for every percentage');
    expect(stages[2]?.textContent).toContain('64.9% of recipients · 79.9% of previous step');
    expect(stages[4]?.className).toContain('funnel__stage--unavailable');
    expect(root.querySelector('.funnel')?.parentElement?.parentElement?.textContent).toContain('Instagram do not report reads');
  });

  it('leaves out the receipts note when every channel reports reads', () => {
    const root = renderAnalytics(screen(report({ channels: [report().channels[0] as CampaignReport['channels'][number]] })));
    expect(root.textContent).not.toContain('do not report reads');
  });

  it('draws volume over time with a text equivalent, and a line only for more than one day', () => {
    const root = renderAnalytics(screen());
    const figure = root.querySelector('.chart-figure') as HTMLElement;
    expect(figure.getAttribute('dir')).toBe('ltr');
    expect(figure.querySelectorAll('.chart__bar')).toHaveLength(3);
    expect(figure.querySelector('.chart__line')).not.toBeNull();
    const rows = Array.from(root.querySelectorAll('.visually-hidden-table tbody tr'));
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('—');

    const single = renderAnalytics(screen(report({ trend: [{ day: '2026-09-05', recipients: 10, accepted: 9, delivered: 8, read: 1, failed: 0 }] })));
    expect(single.querySelector('.chart__line')).toBeNull();

    const many = Array.from({ length: 14 }, (_, index) => ({ day: `2026-09-${String(index + 1).padStart(2, '0')}`, recipients: index, accepted: 0, delivered: 0, read: 0, failed: 0 }));
    expect(renderAnalytics(screen(report({ trend: many }))).querySelectorAll('.chart__tick').length).toBeLessThan(14);
  });

  it('says so when the scope has no recipients or no days', () => {
    const empty = report({ milestones: { denominator: 0, accepted: 0, delivered: 0, read: 0 }, trend: [] });
    const root = renderAnalytics(screen(empty));
    expect(root.textContent).toContain('No recipients in this scope');
    expect(root.querySelector('.funnel')).toBeNull();
    expect(root.querySelector('.kpi')?.parentElement?.textContent).toContain('—');
    const noDays = renderAnalytics(screen(report({ trend: [] })));
    expect(noDays.textContent).toContain('No days in this scope');
  });

  it('breaks results down by channel, marking what a channel does not report', () => {
    const root = renderAnalytics(screen());
    const table = Array.from(root.querySelectorAll('.panel')).find((panel) => panel.querySelector('.panel__title')?.textContent === 'By channel') as HTMLElement;
    expect(table.textContent).toContain('71.6%');
    expect(table.textContent).toContain('Not reported');
    const none = renderAnalytics(screen(report({ channels: [] })));
    expect(none.textContent).toContain('No channel data');
  });

  it('names failure reasons, showing an unknown code as itself', () => {
    const root = renderAnalytics(screen());
    const reasons = Array.from(root.querySelectorAll('.panel')).find((panel) => panel.querySelector('.panel__title')?.textContent === 'Failure reasons') as HTMLElement;
    expect(reasons.textContent).toContain('Rejected by provider');
    expect(reasons.textContent).toContain('brand_new_code');
    expect(renderAnalytics(screen(report({ errors: [] }))).textContent).toContain('No failures recorded');
  });

  it('shows only the current states that have recipients in them', () => {
    const root = renderAnalytics(screen());
    const states = Array.from(root.querySelectorAll('.panel')).find((panel) => panel.querySelector('.panel__title')?.textContent === 'Current state') as HTMLElement;
    expect(states.querySelectorAll('.barlist__row')).toHaveLength(9);
    expect(states.textContent).not.toContain('Cancelled');
    const zero = report({ current: { denominator: 0, planned: 0, queued: 0, in_flight: 0, accepted: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, outcome_unknown: 0 } });
    expect(renderAnalytics(screen(zero)).textContent).toContain('There is nothing to show in this scope.');
  });

  it('lists campaigns with progress, inclusion and a way in', () => {
    const root = renderAnalytics(screen());
    const rows = root.querySelectorAll('[data-report-campaign]');
    expect(rows[0]?.textContent).toContain('618 / 22');
    expect(rows[0]?.textContent).toContain('85.8%');
    expect(rows[0]?.querySelector('.badge--danger')?.textContent).toBe('19');
    expect(rows[0]?.querySelector('[data-act="campaign-open"]')?.getAttribute('data-arg')).toBe('c-1');
    const campaignDrilldown = rows[0]?.querySelector('a[href*="/inbox"]') as HTMLAnchorElement;
    expect(JSON.parse(parseHash(campaignDrilldown.getAttribute('href') ?? '').params.filters ?? '[]')).toEqual([
      { key: 'campaign_id', operator: 'eq', value: 'c-1' },
    ]);
    expect(rows[1]?.textContent).toContain('Not started');
    expect(rows[1]?.textContent).toContain('—');
    expect(renderAnalytics(screen(report({ campaigns: [] }))).textContent).toContain('No campaigns in this scope');
  });

  it('shows costs only when there are any', () => {
    expect(renderAnalytics(screen()).textContent).toContain('Reconciled');
    expect(renderAnalytics(screen(report({ costs: [] }))).textContent).not.toContain('Reconciled');
  });

  it('speaks Arabic by default', () => {
    const root = renderAnalytics(screen(report(), 'ar'));
    expect(root.textContent).toContain('مسار التسليم');
    expect(root.textContent).toContain('غير مقاسة');
  });
});

describe('the export', () => {
  it('reads an expired completed export as expired', () => {
    expect(exportView(exportJob({ state: 'completed', expires_at: '2026-09-09T09:00:00.000Z' }), NOW)).toBe('expired');
    expect(exportView(exportJob({ state: 'completed', expires_at: '2026-09-10T09:00:00.000Z' }), NOW)).toBe('completed');
    expect(exportView(exportJob({ state: 'completed' }), NOW)).toBe('completed');
    expect(exportView(exportJob({ state: 'failed' }), NOW)).toBe('failed');
  });

  it('shows each state the server can report', () => {
    const state = screen();
    const view = (job: CampaignReportExport): HTMLElement => {
      state.live.campaignReportExport = { status: 'ready', loadedAt: 1, value: job };
      return renderAnalytics(state).querySelector('[data-export]') as HTMLElement;
    };
    expect(view(exportJob()).getAttribute('data-export')).toBe('queued');
    expect(view(exportJob()).querySelector('.spinner')).not.toBeNull();
    expect(view(exportJob({ state: 'running' })).textContent).toContain('Preparing the CSV export (all campaigns)');
    const done = view(exportJob({ state: 'completed', row_count: 42, download_url: '/api/v1/x/content', expires_at: '2026-09-10T09:30:00.000Z', campaign_id: 'c-1' }));
    expect(done.textContent).toContain('CSV ready: 42 rows (Reminder)');
    expect(done.querySelector('a[download]')?.getAttribute('href')).toBe('/api/v1/x/content');
    expect(view(exportJob({ state: 'completed', row_count: null, download_url: null, campaign_id: 'c-gone' })).textContent).toContain('0 rows (one campaign)');
    expect(view(exportJob({ state: 'failed', error_code: 'export_generation_failed' })).textContent).toContain('The export failed');
    expect(view(exportJob({ state: 'completed', expires_at: '2026-09-09T00:00:00.000Z', download_url: '/x' })).querySelector('a')).toBeNull();
  });

  it('says what the file does not follow when the period or channel is narrowed', () => {
    const state = screen();
    state.analyticsFilters = { ...NO_ANALYTICS_FILTERS, channel: 'whatsapp' };
    state.live.campaignReportExport = { status: 'ready', loadedAt: 1, value: exportJob() };
    expect(renderAnalytics(state).textContent).toContain('period and channel are not applied');
  });

  it('shows nothing before an export, and a refusal beside the page', () => {
    const state = screen();
    expect(renderAnalytics(state).querySelector('[data-export]')).toBeNull();
    state.live.campaignReportExport = { status: 'loading' };
    expect(renderAnalytics(state).querySelector('[data-export]')).toBeNull();
    state.live.campaignReportExport = { status: 'error', error: { code: 'x', message: 'Denied', requestId: 'r-8', status: 403, details: [] } };
    expect(renderAnalytics(state).querySelector('[role="alert"]')?.textContent).toContain('r-8');
    state.live.busy = 'campaign-report-export';
    expect((renderAnalytics(state).querySelector('[data-act="live-report-export"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
