import { describe, expect, it } from 'vitest';
import { ApiClient, type FetchLike } from './client.js';
import { AutomationsApi, disconnectedAutomationsApi, type Automation, type AutomationInput } from './automations.js';

const WORKFLOW = { version: 1 as const, trigger: { type: 'manual', config: {} }, target: { type: 'matching_conditions', config: {} }, steps: [{ id: 'step_1', type: 'create_internal_notification', config: {} }], safety: { approvalRequired: true, duplicateWindowSeconds: 1 } };
const INPUT: AutomationInput = { name: 'Welcome', description: null, timezone: 'UTC', workflow: WORKFLOW };
const AUTOMATION = { id: 'a-1', templateKey: null, state: 'draft', nextRunAt: null, lastRunAt: null, version: 2, ...INPUT } as Automation;

describe('AutomationsApi', () => {
  it('maps every automation intent to its HTTP operation', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetch: FetchLike = (path, init) => { calls.push({ path, init }); return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })); };
    const api = new AutomationsApi(new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => 'csrf' }));
    await api.templates('t'); await api.whatsappTemplates('t'); await api.list('t'); await api.runs('t');
    await api.useTemplate('t', 'a/b', 'Copy'); await api.create('t', INPUT); await api.update('t', 'a-1', 2, INPUT); await api.transition('t', AUTOMATION, 'activate');
    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ['GET','/api/v1/tenants/t/automation-templates'],['GET','/api/v1/tenants/t/whatsapp-templates'],['GET','/api/v1/tenants/t/automations?sort=updated_desc&limit=25'],['GET','/api/v1/tenants/t/automation-runs?limit=25'],
      ['POST','/api/v1/tenants/t/automation-templates/a%2Fb/use'],['POST','/api/v1/tenants/t/automations'],['PATCH','/api/v1/tenants/t/automations/a-1'],['POST','/api/v1/tenants/t/automations/a-1/activate'],
    ]);
    expect(JSON.parse(String(calls[6]?.init.body))).toMatchObject({ version: 2, name: 'Welcome' });
    expect(JSON.parse(String(calls[7]?.init.body))).toEqual({ version: 2 });
  });

  it('has an honest disconnected default', async () => {
    const api = disconnectedAutomationsApi();
    expect((await api.templates('t')).ok).toBe(false);
    expect((await api.whatsappTemplates('t')).ok).toBe(false);
    expect((await api.list('t')).ok).toBe(false);
    expect((await api.runs('t')).ok).toBe(false);
    expect((await api.create('t', INPUT)).ok).toBe(false);
  });

  it('omits the query marker when every optional query value is empty', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = (path) => {
      calls.push(path);
      return Promise.resolve(new Response(JSON.stringify({ data: [], nextCursor: null, hasMore: false }), { status: 200 }));
    };
    const api = new AutomationsApi(new ApiClient({ baseUrl: '/api/v1', fetch, readCsrfToken: () => null }));
    // The public query type requires a numeric page size. This malformed value
    // is only used to exercise the serializer's empty-query branch; the API
    // never receives it from production state.
    await api.list('t', { search: '', state: '', sort: '' as never, cursor: null, limit: '' as never });
    expect(calls).toEqual(['/api/v1/tenants/t/automations']);
  });
});
