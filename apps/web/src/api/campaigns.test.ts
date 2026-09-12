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
    await api.validate('tenant-1', 'campaign-1');
    await api.approve('tenant-1', 'campaign-1');
    await api.launch('tenant-1', 'campaign-1', 'launch-key');
    await api.control('tenant-1', 'campaign-1', 'pause');
    await api.recipients('tenant-1', 'campaign-1');

    expect(calls.map(({ path, init }) => [init.method, path])).toEqual([
      ['GET', '/api/v1/tenants/tenant-1/campaigns'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/validate'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/approve'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/launch'],
      ['POST', '/api/v1/tenants/tenant-1/campaigns/campaign-1/control'],
      ['GET', '/api/v1/tenants/tenant-1/campaigns/campaign-1/recipients'],
    ]);
    expect(calls[1]?.init.headers).toMatchObject({ 'idempotency-key': 'create-key' });
    expect(calls[4]?.init.headers).toMatchObject({ 'idempotency-key': 'launch-key' });
    expect(JSON.parse(String(calls[5]?.init.body))).toEqual({ action: 'pause' });
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
  });
});
