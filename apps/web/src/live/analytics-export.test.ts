/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignReport, OperationalReport } from '../api/campaigns';
import { createState } from '../state';
import type { LiveContext } from './actions';
import { exportAnalytics, printAnalytics, saveFile } from './analytics-export';

/**
 * The files are made from the reports the server sent; for a workbook every
 * report is read first, and the ownership log page by page.
 */

const NOW = new Date('2026-09-26T10:00:00.000Z');
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });

const CAMPAIGN = {
  generated_at: NOW.toISOString(), fresh_through: NOW.toISOString(), timezone: 'UTC',
  filters: { from: null, to: null, channel: null, campaign_id: null }, definitions: { campaigns: 0, executions: 0 },
  audience: { denominator: 0, eligible: 0, excluded: 0 },
  current: { denominator: 0, planned: 0, queued: 0, in_flight: 0, accepted: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, outcome_unknown: 0 },
  milestones: { denominator: 0, accepted: 0, delivered: 0, read: 0 }, costs: [], channels: [], errors: [], trend: [], campaigns: [],
} as unknown as CampaignReport;

const OPERATIONS = {
  generatedAt: NOW.toISOString(), filters: {}, agentOptions: [],
  conversations: { open: 0, unassigned: 0, new: 0, resolved: 0, assignedInPeriod: 0, humanMessages: 0, internalNotes: 0, reassignments: 0, backlogByStatus: [], backlogByChannel: [], backlogByTeam: [], assignmentWorkload: [] },
  timing: { firstResponseMeasured: 0, firstResponseAverageSeconds: null, firstResponseMedianSeconds: null, resolutionMeasured: 0, resolutionAverageSeconds: null, resolutionMedianSeconds: null },
  responseBuckets: [], channels: [], agents: [],
} as unknown as OperationalReport;

const ROW = { id: 'a-1', timestamp: NOW.toISOString(), conversationId: 'c-1', customer: null, action: 'claim', previousAssignee: null, assignedTo: { membershipId: 'm', displayName: 'Sara' }, actor: null };

function setup(tenant: string | null = 't') {
  const state = createState(NOW);
  state.lang = 'en';
  state.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: tenant };
  // The filter directories are already read, so only the reports are fetched.
  state.live.teams = { status: 'ready', loadedAt: 1, value: [] };
  state.live.connections = { status: 'ready', loadedAt: 1, value: [] };
  state.live.workspaceLabels = { status: 'ready', loadedAt: 1, value: [] };
  state.live.campaigns = { status: 'ready', loadedAt: 1, value: [] };
  let page = 0;
  const api = {
    report: vi.fn(() => ok(CAMPAIGN)),
    operationsReport: vi.fn(() => ok(OPERATIONS)),
    teamReport: vi.fn(() => ok([])),
    responseReport: vi.fn(() => ok({ measured: 0, averageSeconds: null, medianSeconds: null, buckets: [], byAgent: [], byChannel: [] })),
    resolutionReport: vi.fn(() => ok({ resolvedEpisodes: 0, averageSeconds: null, medianSeconds: null, reopenedEpisodes: 0, byAgent: [], byChannel: [] })),
    // Twenty-five pages are on offer; a workbook reads twenty of them.
    assignmentsReport: vi.fn(() => {
      page += 1;
      return ok({ data: [{ ...ROW, id: `a-${String(page)}` }], nextCursor: page < 25 ? `p-${String(page)}` : null });
    }),
  };
  Object.defineProperty(state.live, 'campaignsApi', { value: api });
  const context: LiveContext = { state, live: state.live, refresh: vi.fn(), now: () => NOW.getTime(), newKey: () => 'k', endSession: vi.fn(), switchWorkspace: vi.fn() };
  return { state, context, api };
}

const saved: { name: string; type: string; size: number }[] = [];

function captureDownloads(): void {
  saved.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const file = blob as Blob;
    saved.push({ name: '', type: file.type, size: file.size });
    return 'blob:analytics';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    (saved.at(-1) as { name: string }).name = this.download;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saving a file', () => {
  it('hands the browser a named download and lets the URL go', () => {
    captureDownloads();
    saveFile('x.csv', 'text/csv', 'a,b');
    expect(saved).toEqual([{ name: 'x.csv', type: 'text/csv', size: 3 }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:analytics');
  });
});

describe('exporting analytics', () => {
  it('refuses a format it does not make, and does nothing without a workspace', async () => {
    const { context } = setup();
    expect(await exportAnalytics(context, 'pdf')).toBe(false);
    expect(await exportAnalytics(setup(null).context, 'csv')).toBe(false);
  });

  it('writes the open report as a CSV named for its view and day', async () => {
    captureDownloads();
    const { context, state, api } = setup();
    state.analyticsView = 'teams';
    state.live.teamReport = { status: 'ready', loadedAt: 1, value: [] };
    expect(await exportAnalytics(context, 'csv')).toBe(true);
    expect(api.teamReport).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({ name: 'convo-analytics-teams-2026-09-26.csv', type: 'text/csv;charset=utf-8' });
    expect(state.toasts.at(-1)?.text).toBe('Downloaded this report as a CSV.');
    expect(state.live.busy).toBeNull();
  });

  it('says so when the open report has not arrived yet', async () => {
    captureDownloads();
    const { context, state } = setup();
    state.lang = 'ar';
    state.analyticsView = 'responses';
    expect(await exportAnalytics(context, 'csv')).toBe(false);
    expect(saved).toEqual([]);
    expect(state.toasts.at(-1)).toMatchObject({ tone: 'danger', text: 'لا توجد أرقام لتصديرها بعد. انتظر حتى يكتمل التقرير.' });
  });

  it('reads every report, and twenty pages of the ownership log, into one workbook', async () => {
    captureDownloads();
    const { context, state, api } = setup();
    expect(await exportAnalytics(context, 'xlsx')).toBe(true);
    for (const read of [api.report, api.operationsReport, api.teamReport, api.responseReport, api.resolutionReport]) expect(read).toHaveBeenCalled();
    expect(api.assignmentsReport).toHaveBeenCalledTimes(20);
    expect(state.live.assignmentReport).toMatchObject({ status: 'ready' });
    expect(saved[0]).toMatchObject({ name: 'convo-analytics-2026-09-26.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(state.toasts.at(-1)?.text).toMatch(/^Downloaded an Excel workbook with \d+ sheets\.$/);
    // A second workbook reads nothing again.
    await exportAnalytics(context, 'xlsx');
    expect(api.report).toHaveBeenCalledTimes(1);
  });

  it('writes an Arabic workbook right to left', async () => {
    captureDownloads();
    const { context, state } = setup();
    state.lang = 'ar';
    expect(await exportAnalytics(context, 'xlsx')).toBe(true);
    expect(state.toasts.at(-1)?.text).toMatch(/^تم تنزيل ملف Excel فيه \d+ ورقة\.$/);
  });
});

describe('printing', () => {
  it('opens the print dialog where there is one', () => {
    const print = vi.fn();
    expect(printAnalytics({ print })).toBe(true);
    expect(print).toHaveBeenCalledOnce();
    expect(printAnalytics({})).toBe(false);
    expect(printAnalytics(null)).toBe(false);
  });
});
