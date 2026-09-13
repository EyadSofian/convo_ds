import { describe, expect, it } from 'vitest';
import type { FetchLike } from './client.js';
import { ApiClient } from './client.js';
import { CampaignsApi, disconnectedCampaignsApi, type CreateCampaignInput } from './campaigns.js';

const INPUT: CreateCampaignInput = {
  name: 'September intake',
  objective: 'Enrolment',
  connectionId: 'connection-1',
  content: { text: 'Hello' },
  variables: { display_name: 'display_name' },
  audienceFilter: { search: 'Mona' },
  timezone: 'Africa/Cairo',
  budgetAmountMinor: 100,
  budgetCurrency: 'USD',
};

describe('CampaignsApi', () => {
  it('maps every campaign intent to its documented HTTP operation', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetch: FetchLike = (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    };
    const api = new CampaignsApi(new ApiClient({
      baseUrl: '/api/v1',
      fetch,
      readCsrfToken: () => 'csrf',
    }));

    await api.list('tenant-1');
    await api.create('tenant-1', INPUT, 'create-key');
    await api.update('tenant-1', 'campaign-1', INPUT, 3, 'update-key');
    await api.validate('tenant-1', 'campaign-1');
    await api.approve('tenant-1', 'campaign-1');
    await api.launch('tenant-1', 'campaign-1', 'launch-key');
    await api.control('tenant-1', 'campaign-1', 'pause');
    await api.retryFailures('tenant-1', 'campaign-1', 'retry-key');
    await api.clone('tenant-1', 'campaign-1', 'Copy', 'clone-key');
    await api.testSend('tenant-1', 'campaign-1', 'recipient-1', 3, 'test-key');
    await api.recipients('tenant-1', 'campaign-1');
    await api.report('tenant-1');
    await api.createReportExport('tenant-1', null, 'export-key');
    await api.reportExport('tenant-1', 'export-1');

    expect(calls.map(({ path, init }) => [init.method, path])).toEqual([
      ['GET', '/api/v1/tenants/tenant-1/campaigns'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns'],
      ['PATCH', '/api/v1/tenants/tenant-1/campaigns/campaign-1'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/validate'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/approve'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/launch'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/control'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/retry'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/clone'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/test-send'],
      ['GET', '/api/v1/tenants/tenant-1/campaigns/campaign-1/recipients'],
      ['GET', '/api/v1/tenants/tenant-1/reports/campaigns'],
      ['POST', '/api/v1/tenants/tenant-1/reports/campaigns/exports'],
      ['GET', '/api/v1/tenants/tenant-1/reports/campaigns/exports/export-1'],
    ]);
    expect(calls[1]?.init.headers).toMatchObject({ 'idempotency-key': 'create-key' });
    expect(calls[2]?.init.headers).toMatchObject({ 'idempotency-key': 'update-key' });
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({ expectedVersion: 3, name: 'September intake' });
    expect(calls[5]?.init.headers).toMatchObject({ 'idempotency-key': 'launch-key' });
    expect(JSON.parse(String(calls[6]?.init.body))).toEqual({ action: 'pause' });
    expect(calls[7]?.init.headers).toMatchObject({ 'idempotency-key': 'retry-key' });
    expect(calls[8]?.init.headers).toMatchObject({ 'idempotency-key': 'clone-key' });
    expect(calls[9]?.init.headers).toMatchObject({ 'idempotency-key': 'test-key' });
    expect(JSON.parse(String(calls[9]?.init.body))).toEqual({ testRecipientId: 'recipient-1', expectedVersion: 3 });
    expect(calls[12]?.init.headers).toMatchObject({ 'idempotency-key': 'export-key' });
    expect(JSON.parse(String(calls[12]?.init.body))).toEqual({ format: 'csv', campaignId: null });
  });

  it('scopes the report by the filters that are set, and schedules a launch', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetch: FetchLike = (path, init) => {
      calls.push({ path, init });
      return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    const api = new CampaignsApi(new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => 'csrf' }));

    await api.report('tenant-1', { from: '', to: '', channel: '', campaignId: '' });
    await api.report('tenant-1', { from: '2026-09-01', to: '2026-09-09', channel: 'whatsapp', campaignId: 'campaign-1' });
    await api.launch('tenant-1', 'campaign-1', 'launch-key', '2026-09-10T09:00:00.000Z');

    expect(calls.map((call) => call.path)).toEqual([
      '/api/v1/tenants/tenant-1/reports/campaigns',
      '/api/v1/tenants/tenant-1/reports/campaigns?from=2026-09-01&to=2026-09-09&channel=whatsapp&campaignId=campaign-1',
      '/api/v1/tenants/tenant-1/campaigns/campaign-1/launch',
    ]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ mode: 'scheduled', scheduledFor: '2026-09-10T09:00:00.000Z' });
  });

  it('has an honest disconnected default', async () => {
    const api = disconnectedCampaignsApi();
    const result = await api.list('tenant-1');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'network',
        message: 'No HTTP transport is configured.',
        requestId: null,
        status: null,
        details: [],
      },
    });
    expect((await api.launch('tenant-1', 'campaign-1', 'key')).ok).toBe(false);
    expect((await api.retryFailures('tenant-1', 'campaign-1', 'key')).ok).toBe(false);
    expect((await api.createReportExport('tenant-1', null, 'key')).ok).toBe(false);
    expect((await api.reportExport('tenant-1', 'export-1')).ok).toBe(false);
  });
});
