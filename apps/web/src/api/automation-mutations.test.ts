import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './client.js';
import { AutomationsApi, type Automation } from './automations.js';
import { ConversationsApi } from './conversations.js';
import { SavedViewsApi } from './saved-views.js';
import { CampaignsApi, type OperationalReportFilterInput } from './campaigns.js';

const automation = { id: 'auto-1', version: 4 } as Automation;
const input = { name: 'Inbox', resource: 'conversations' as const, visibility: 'private' as const, teamId: null, conditions: { version: 1 as const, root: { kind: 'group' as const, match: 'all' as const, conditions: [] } } };

function fake() {
  const get = vi.fn().mockResolvedValue({ ok: true, data: [] });
  const page = vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null, hasMore: false } });
  const post = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const patch = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const del = vi.fn().mockResolvedValue({ ok: true, data: undefined });
  return { client: { get, page, post, patch, delete: del } as unknown as ApiClient, get, page, post, patch, del };
}

describe('web API mutation/query boundaries', () => {
  it('sends automation delete with the optimistic version', async () => {
    const f = fake();
    await new AutomationsApi(f.client).deleteDraft('tenant', automation);
    expect(f.del).toHaveBeenCalledWith('/tenants/tenant/automations/auto-1', { body: { version: 4 } });
  });

  it('serializes supervisor API calls and preserves page failures', async () => {
    const f = fake();
    const api = new ConversationsApi(f.client);
    await api.supervisorAgents('tenant');
    await api.supervisorWorkload('tenant', 'agent/1');
    await api.list('tenant', { queue: 'all', sort: 'created_desc', limit: 10, cursor: 'cursor', search: 'Sara', filters: [{ key: 'status', operator: 'eq', value: 'open' }] });
    await api.supervisorList('tenant', 'agent-1', { queue: 'all', sort: 'created_desc', limit: 10, cursor: 'cursor', search: 'Sara', filters: [{ key: 'status', operator: 'eq', value: 'open' }] });
    expect(f.get).toHaveBeenNthCalledWith(1, '/tenants/tenant/supervisor/agents');
    expect(f.get).toHaveBeenNthCalledWith(2, '/tenants/tenant/supervisor/workload?agent=agent%2F1');
    expect(f.page).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant/supervisor/conversations?agent=agent-1&queue=all&sort=created_desc&limit=10&cursor=cursor&search=Sara&filter='));
    f.page.mockResolvedValueOnce({ ok: false, error: { code: 'network', message: 'offline', status: null, details: [] } });
    await expect(api.supervisorList('tenant', 'agent-1', { queue: 'all', sort: 'activity_desc', limit: 50, cursor: null, search: null, filters: [] })).resolves.toMatchObject({ ok: false });
    const failedList = fake();
    failedList.page.mockResolvedValue({ ok: false, error: { code: 'network', message: 'offline', status: null, details: [] } });
    await expect(new ConversationsApi(failedList.client).list('tenant', { queue: 'all', sort: 'activity_desc', limit: 50, cursor: null, search: null, filters: [] })).resolves.toMatchObject({ ok: false });
  });

  it('uses server-backed saved view CRUD only', async () => {
    const f = fake();
    const api = new SavedViewsApi(f.client);
    await api.list('tenant');
    await api.create('tenant', input);
    await api.update('tenant', 'view-1', 2, input);
    await api.retire('tenant', 'view-1', 3);
    expect(f.get).toHaveBeenCalledWith('/tenants/tenant/saved-views?resource=conversations');
    expect(f.post).toHaveBeenCalledWith('/tenants/tenant/saved-views', { body: input });
    expect(f.patch).toHaveBeenCalledWith('/tenants/tenant/saved-views/view-1', { body: { ...input, version: 2 } });
    expect(f.del).toHaveBeenCalledWith('/tenants/tenant/saved-views/view-1', { body: { version: 3 } });
  });

  it('reads and saves reusable campaign audiences, and counts an audience without freezing it', async () => {
    const f = fake();
    const views = new SavedViewsApi(f.client);
    await views.audiences('tenant');
    await views.createAudience('tenant', { name: 'VIPs', description: null, conditions: input.conditions });
    expect(f.get).toHaveBeenCalledWith('/tenants/tenant/audiences');
    expect(f.post).toHaveBeenCalledWith('/tenants/tenant/audiences', { body: { name: 'VIPs', description: null, conditions: input.conditions } });
    await new CampaignsApi(f.client).previewAudience('tenant', 'channel-1', { search: 'Mo' });
    expect(f.post).toHaveBeenLastCalledWith('/tenants/tenant/campaigns/audience-preview', { body: { connectionId: 'channel-1', audienceFilter: { search: 'Mo' } } });
  });

  it('omits empty report filters and appends all supported operational filters', async () => {
    const f = fake();
    const api = new CampaignsApi(f.client);
    const empty: OperationalReportFilterInput = { from: '', to: '', agentId: '', teamId: '', channel: '', connectionId: '', labelId: '', campaignId: '', priority: '', status: '' };
    const full: OperationalReportFilterInput = { from: '2026-01-01', to: '2026-01-31', agentId: 'agent', teamId: 'team', channel: 'whatsapp', connectionId: 'connection', labelId: 'label', campaignId: 'campaign', priority: 'high', status: 'open' };
    await api.report('tenant');
    await api.report('tenant', { from: '', to: '', channel: '', campaignId: '' });
    await api.operationsReport('tenant', empty);
    await api.assignmentsReport('tenant', full, 'cursor', 10);
    await api.responseReport('tenant', full);
    await api.resolutionReport('tenant', full);
    await api.teamReport('tenant', full);
    await api.responseReport('tenant', empty);
    await api.resolutionReport('tenant', empty);
    await api.teamReport('tenant', empty);
    expect(f.get).toHaveBeenCalledWith('/tenants/tenant/reports/campaigns');
    expect(f.page).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant/reports/assignments?from=2026-01-01'));
    expect(f.get).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant/reports/responses?from=2026-01-01'));
    expect(f.get).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant/reports/resolutions?from=2026-01-01'));
    expect(f.get).toHaveBeenCalledWith(expect.stringContaining('/tenants/tenant/reports/teams?from=2026-01-01'));
  });
});
