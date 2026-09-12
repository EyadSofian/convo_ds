/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../data';
import type { AppState } from '../state';
import { createState } from '../state';
import {
  renderAnalytics,
  renderBroadcasts,
  renderSettings,
} from './workspace';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function stateAs(role: RoleId = 'supervisor', lang: 'ar' | 'en' = 'ar'): AppState {
  const state = createState(NOW);
  state.role = role;
  state.lang = lang;
  return state;
}

function text(element: HTMLElement): string {
  return element.textContent ?? '';
}

describe('broadcasts', () => {
  function liveState(role: RoleId = 'admin', lang: 'ar' | 'en' = 'ar'): AppState {
    const state = stateAs(role, lang);
    state.live.session = { status: 'signed_in', email: 'owner@test.local', memberships: [], tenantId: 'tenant-1' };
    state.live.campaigns = { status: 'ready', loadedAt: NOW.getTime(), value: [
      {
        id: 'campaign-1', name: 'September intake', objective: 'Enrolment', connection_id: 'channel-1',
        state: 'ready', version: 3, revision_id: 'revision-1', revision: 1,
        revision_hash: 'a'.repeat(64), approved: true,
        content: { text: 'Welcome' }, variables: {}, audience_filter: {}, timezone: 'UTC',
        expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD',
        audience: { total: 12, eligible: 10, excluded: 2 }, execution: null,
        created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      },
      {
        id: 'campaign-2', name: 'Started campaign', objective: null, connection_id: 'channel-1',
        state: 'running', version: 4, revision_id: 'revision-2', revision: 1,
        revision_hash: 'b'.repeat(64), approved: true,
        content: { text: 'Reminder' }, variables: {}, audience_filter: {}, timezone: 'UTC',
        expires_at: null, budget_amount_minor: '0.000000', budget_currency: 'USD',
        audience: { total: 4, eligible: 4, excluded: 0 },
        execution: { id: 'execution-2', state: 'running', scheduled_for: null },
        created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      },
    ] };
    return state;
  }

  it('renders only server-backed campaigns and their frozen totals', () => {
    const element = renderBroadcasts(liveState());
    expect(element.querySelectorAll('.broadcast-card')).toHaveLength(2);
    expect(text(element)).toContain('September intake');
    expect(text(element)).toContain('مؤهل للإرسال');
    expect(text(element)).not.toContain('بيانات تجريبية');
  });

  it('offers actions that the current server state can accept', () => {
    const element = renderBroadcasts(liveState());
    expect(element.querySelector('[data-act="live-campaign-launch"]')).not.toBeNull();
    expect(element.querySelector('[data-act="live-campaign-control"][data-arg$=":pause"]')).not.toBeNull();
    expect(element.querySelector('[data-act="live-campaign-ledger"]')).not.toBeNull();
    expect(element.querySelectorAll('[data-act="live-campaign-clone"]')).toHaveLength(2);
    expect(element.querySelectorAll('[data-arg="campaign-edit:campaign-1"]')).toHaveLength(1);
    expect(element.querySelector('[data-arg="campaign-edit:campaign-2"]')).toBeNull();
    expect(element.querySelector('[data-arg="campaign-test-send:campaign-1"]')).not.toBeNull();
    expect(element.querySelector('[data-arg="campaign-test-send:campaign-2"]')).toBeNull();
  });

  it('shows signed-out, loading, failure and empty states distinctly', () => {
    const loading = stateAs('admin');
    expect(renderBroadcasts(loading).querySelector('[aria-busy="true"]')).not.toBeNull();
    loading.live.session = { status: 'signed_out', error: null };
    expect(text(renderBroadcasts(loading))).toContain('تحتاج جلسة');
    loading.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: 't' };
    loading.live.campaigns = { status: 'error', error: { code: 'down', message: 'الخادم متوقف', requestId: 'req-1', status: 503, details: [] } };
    expect(text(renderBroadcasts(loading))).toContain('req-1');
    loading.live.campaigns = { status: 'ready', value: [], loadedAt: 1 };
    expect(text(renderBroadcasts(loading))).toContain('لا توجد حملات');

    const noTenant = stateAs('admin');
    noTenant.live.session = { status: 'signed_in', email: 'a@b.c', memberships: [], tenantId: null };
    expect(text(renderBroadcasts(noTenant))).toContain('لا توجد عضوية نشطة');

    const network = liveState();
    network.live.campaigns = { status: 'error', error: { code: 'network', message: 'offline', requestId: null, status: null, details: [] } };
    expect(text(renderBroadcasts(network))).toContain('تعذر الاتصال بالخادم');
  });

  it('hides authoring controls without campaign.draft', () => {
    const element = renderBroadcasts(liveState('supervisor'));
    expect(element.querySelector('[data-arg="campaign"]')).toBeNull();
    expect(element.querySelector('[data-act="live-campaign-launch"]')).toBeNull();
  });

  it('renders a recipient ledger from the server response', () => {
    const state = liveState();
    state.live.selectedCampaignId = 'campaign-2';
    state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: [
      { id: 'r1', contact_id: 'c1', display_name: 'Mona', external_id: '2010', state: 'planned', last_error: null, estimated_amount_minor: '12.500000', currency: 'USD' },
    ] };
    const element = renderBroadcasts(state);
    expect(text(element)).toContain('سجل المستلمين');
    expect(text(element)).toContain('Mona');
    expect(text(element)).toContain('12.500000 USD');
  });

  it('renders every actionable campaign state from the server record', () => {
    const state = liveState();
    const base = state.live.campaigns.status === 'ready' ? state.live.campaigns.value[0] : undefined;
    if (base === undefined) throw new Error('fixture has no campaign');
    state.live.campaigns = { status: 'ready', loadedAt: 1, value: [
      { ...base, id: 'draft', state: 'draft', approved: false, audience: null },
      { ...base, id: 'approval', state: 'ready', approved: false, objective: null },
      { ...base, id: 'scheduled', state: 'scheduled', execution: { id: 'e1', state: 'scheduled', scheduled_for: NOW.toISOString() } },
      { ...base, id: 'paused', state: 'paused', execution: { id: 'e2', state: 'paused', scheduled_for: null } },
      { ...base, id: 'failed', state: 'failed', execution: { id: 'e3', state: 'failed', scheduled_for: null } },
    ] };
    state.live.busy = 'some-operation';
    const element = renderBroadcasts(state);
    expect(element.querySelector('[data-act="live-campaign-validate"]')).not.toBeNull();
    expect(element.querySelector('[data-act="live-campaign-approve"]')).not.toBeNull();
    expect(element.querySelector('[data-arg="paused:resume"]')).not.toBeNull();
    expect(element.querySelector('[data-arg="scheduled:cancel"]')).not.toBeNull();
    expect(text(element)).toContain('بلا هدف مكتوب');
    expect(text(element)).toContain('لم يُثبّت');
    expect(element.querySelector('.pill--danger')).not.toBeNull();
    expect(element.querySelector('[data-act="live-campaign-retry"][data-arg="failed"]')).not.toBeNull();
    expect(Array.from(element.querySelectorAll('button')).some((button) => button.disabled)).toBe(true);
  });

  it('distinguishes ledger loading, failure, empty and failed-recipient states', () => {
    const state = liveState('admin', 'en');
    state.live.selectedCampaignId = 'campaign-2';
    expect(text(renderBroadcasts(state))).toContain('Loading ledger');

    state.live.campaignRecipients = { status: 'error', error: { code: 'down', message: 'Ledger unavailable', requestId: null, status: 503, details: [] } };
    expect(text(renderBroadcasts(state))).toContain('Ledger unavailable');
    state.live.campaignRecipients = { status: 'error', error: { code: 'down', message: 'Ledger unavailable', requestId: 'req-ledger', status: 503, details: [] } };
    expect(text(renderBroadcasts(state))).toContain('req-ledger');
    state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: [] };
    expect(text(renderBroadcasts(state))).toContain('No recipients');
    state.live.campaignRecipients = { status: 'ready', loadedAt: 1, value: [
      { id: 'r2', contact_id: 'c2', display_name: 'Omar', external_id: '2011', state: 'failed', last_error: { code: 'provider' }, estimated_amount_minor: null, currency: null },
      { id: 'r3', contact_id: 'c3', display_name: 'Laila', external_id: '2012', state: 'planned', last_error: null, estimated_amount_minor: '1.000000', currency: null },
    ] };
    const failed = renderBroadcasts(state);
    expect(text(failed)).toContain('Omar');
    expect(text(failed)).toContain('—');
    expect(text(failed)).toContain('1.000000');
    expect(failed.querySelector('.pill--danger')).not.toBeNull();
  });

  it('renders in English', () => {
    expect(text(renderBroadcasts(liveState('admin', 'en')))).toContain('Unknown outcomes are never retried automatically');
  });
});

describe('analytics', () => {
  function reportState(lang: 'ar' | 'en' = 'ar'): AppState {
    const state = stateAs('supervisor', lang);
    state.live.session = { status: 'signed_in', email: 'report@test.local', memberships: [], tenantId: 'tenant-1' };
    state.live.campaignReport = { status: 'ready', loadedAt: NOW.getTime(), value: {
      generated_at: NOW.toISOString(), fresh_through: NOW.toISOString(), timezone: 'UTC',
      definitions: { campaigns: 2, executions: 1 }, audience: { denominator: 12, eligible: 10, excluded: 2 },
      current: { denominator: 10, planned: 0, queued: 0, in_flight: 0, accepted: 0, delivered: 4, read: 3, failed: 2, skipped: 0, cancelled: 0, outcome_unknown: 1 },
      milestones: { denominator: 10, accepted: 8, delivered: 7, read: 3 },
      costs: [{ currency: 'USD', estimated_amount_minor: '700.000000', committed_amount_minor: '560.000000', reconciled_amount_minor: '520.000000' }],
      channels: [
        { kind: 'whatsapp', denominator: 8, accepted: 7, delivered: 6, read: 3, delivery_receipts: true, read_receipts: true },
        { kind: 'instagram', denominator: 2, accepted: 1, delivered: 0, read: 0, delivery_receipts: false, read_receipts: false },
      ],
      errors: [{ code: 'provider_rejected', count: 2 }],
      campaigns: [{ id: 'campaign-1', name: 'September', state: 'dispatch_completed', denominator: 10, accepted: 8, delivered: 7, read: 3, failed: 2, outcome_unknown: 1, fresh_through: NOW.toISOString() }],
    } };
    return state;
  }

  it('publishes denominators and freshness', () => {
    const element = renderAnalytics(reportState());
    expect(element.querySelectorAll('.metric').length).toBeGreaterThanOrEqual(4);
    expect(text(element)).toContain('من 10');
    expect(text(element)).toContain('آخر دليل تشغيلي');
    expect(text(element)).not.toContain('بيانات تجريبية');
  });

  it('never reports an unsupported receipt as zero', () => {
    const element = renderAnalytics(reportState());
    const receipts = Array.from(element.querySelectorAll('.card')).find((node) => node.textContent?.includes('الإيصالات')) as HTMLElement;
    const values = Array.from(receipts.querySelectorAll('dd')).map((node) => node.textContent ?? '');
    const unsupported = values.filter((value) => value.includes('غير متاح'));
    expect(unsupported).toHaveLength(1);
    // An unsupported receipt is never rendered as a number, a zero or a ratio.
    for (const value of unsupported) expect(value).not.toMatch(/[0-9%٪]/);
  });

  it('renders channel and workload distributions', () => {
    const element = renderAnalytics(reportState());
    expect(element.querySelectorAll('.bars__row').length).toBe(7);
    expect(text(element)).toContain('provider_rejected');
  });

  it('denies the screen without report.read', () => {
    const element = renderAnalytics(stateAs('agent'));
    expect(element.querySelector('.statebox--denied')).not.toBeNull();
    expect(text(element)).toContain('report.read');
  });

  it('renders in English', () => {
    expect(text(renderAnalytics(reportState('en')))).toContain('Not available');
  });

  it('renders queued, completed, failed and request-failure export states', () => {
    const state = reportState('en');
    state.live.campaignReportExport = { status: 'loading' };
    expect(text(renderAnalytics(state))).toContain('Reading export status');
    state.live.campaignReportExport = { status: 'error', error: { code: 'down', message: 'Export unavailable', requestId: null, status: 503, details: [] } };
    expect(text(renderAnalytics(state))).toContain('Export unavailable');
    state.live.campaignReportExport = { status: 'ready', loadedAt: 1, value: {
      id: 'export-1', campaign_id: null, format: 'csv', state: 'queued', row_count: null,
      error_code: null, requested_at: NOW.toISOString(), completed_at: null, expires_at: null, download_url: null,
    } };
    expect(renderAnalytics(state).querySelector('[data-act="live-report-export-refresh"]')).not.toBeNull();
    state.live.campaignReportExport = { status: 'ready', loadedAt: 2, value: {
      ...state.live.campaignReportExport.value, state: 'failed', error_code: 'export_generation_failed',
    } };
    expect(text(renderAnalytics(state))).toContain('The export failed');
    state.live.campaignReportExport = { status: 'ready', loadedAt: 3, value: {
      ...state.live.campaignReportExport.value, state: 'completed', row_count: null,
      error_code: null, completed_at: NOW.toISOString(), expires_at: NOW.toISOString(), download_url: '/api/v1/export.csv',
    } };
    const complete = renderAnalytics(state);
    expect(complete.querySelector('[data-export-ready="true"]')).not.toBeNull();
    expect((complete.querySelector('a[download]') as HTMLAnchorElement).getAttribute('href')).toBe('/api/v1/export.csv');
    expect(text(complete)).toContain('0 rows');
  });

  it('distinguishes loading, signed-out, no-membership, failure and empty evidence', () => {
    const loading = stateAs('supervisor');
    expect(renderAnalytics(loading).querySelector('[aria-busy="true"]')).not.toBeNull();
    loading.live.session = { status: 'signed_out', error: null };
    expect(text(renderAnalytics(loading))).toContain('تحتاج جلسة');
    loading.live.session = { status: 'signed_in', email: 'x@y.z', memberships: [], tenantId: null };
    expect(text(renderAnalytics(loading))).toContain('لا توجد عضوية نشطة');
    loading.live.session = { status: 'signed_in', email: 'x@y.z', memberships: [], tenantId: 'tenant-1' };
    loading.live.campaignReport = { status: 'error', error: { code: 'down', message: 'Report failed', requestId: 'req-report', status: 503, details: [] } };
    expect(text(renderAnalytics(loading))).toContain('req-report');
    loading.live.campaignReport = { status: 'error', error: { code: 'network', message: 'Offline', requestId: null, status: null, details: [] } };
    expect(text(renderAnalytics(loading))).toContain('تعذر الاتصال بالخادم');

    const empty = reportState('en');
    if (empty.live.campaignReport.status !== 'ready') throw new Error('report fixture not ready');
    empty.live.campaignReport = { status: 'ready', loadedAt: 1, value: {
      ...empty.live.campaignReport.value,
      current: { denominator: 0, planned: 0, queued: 0, in_flight: 0, accepted: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, outcome_unknown: 0 }, milestones: { denominator: 0, accepted: 0, delivered: 0, read: 0 },
      channels: [
        { kind: 'custom', denominator: 0, accepted: 0, delivered: 0, read: 0, delivery_receipts: false, read_receipts: false },
        { kind: 'future_channel', denominator: 0, accepted: 0, delivered: 0, read: 0, delivery_receipts: false, read_receipts: false },
      ],
      costs: [], errors: [],
    } };
    const rendered = renderAnalytics(empty);
    expect(text(rendered)).toContain('No cost evidence yet');
    expect(text(rendered)).toContain('No errors recorded');
    expect(text(rendered)).toContain('Custom channel');
    expect(text(rendered)).toContain('future_channel');
  });
});

describe('settings', () => {
  it('renders working form controls with defaults', () => {
    const element = renderSettings(stateAs('admin'));
    expect(element.querySelectorAll('input, select')).toHaveLength(4);
    expect((element.querySelector('[data-form="company"]') as HTMLInputElement).value).toBe('Digital School');
    expect((element.querySelector('[data-form="tz"]') as HTMLSelectElement).value).toBe('Africa/Cairo');
    expect(element.querySelectorAll('[role="switch"]')).toHaveLength(3);
  });

  it('reflects edited form values', () => {
    const state = stateAs('admin');
    state.dialogForm = {
      company: 'Noor Retail',
      tz: 'Asia/Riyadh',
      retention: '36',
      slaPause: 'off',
      away: 'on',
      maskPhones: 'off',
    };
    const element = renderSettings(state);
    expect((element.querySelector('[data-form="company"]') as HTMLInputElement).value).toBe('Noor Retail');
    expect((element.querySelector('[data-form="tz"]') as HTMLSelectElement).value).toBe('Asia/Riyadh');
    const switches = Array.from(element.querySelectorAll('[role="switch"]')).map((node) =>
      node.getAttribute('aria-checked'),
    );
    expect(switches).toEqual(['false', 'true', 'false']);
  });

  it('states the retention and suppression rules', () => {
    const element = renderSettings(stateAs('admin'));
    expect(text(element)).toContain('لا يوجد زر «إلغاء حجب»');
    expect(text(element)).toContain('UTC');
    expect(text(element)).toContain('30 ثانية');
  });

  it('renders in English', () => {
    expect(text(renderSettings(stateAs('admin', 'en')))).toContain('Business hours');
  });
});
