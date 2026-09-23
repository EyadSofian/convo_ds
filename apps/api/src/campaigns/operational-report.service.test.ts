import { describe, expect, it } from 'vitest';
import { ApiHttpError } from '../http-error.js';
import { parseOperationalReportFilters, validateReportEntities } from './operational-report.service.js';
import type { Principal, SqlExecutor } from '@convo/domain';

const agentId = '91000000-0000-4000-8000-000000000001';
const teamId = '91000000-0000-4000-8000-000000000002';
const connectionId = '91000000-0000-4000-8000-000000000003';
const labelId = '91000000-0000-4000-8000-000000000004';
const campaignId = '91000000-0000-4000-8000-000000000005';
const principal: Principal = {
  membershipId: agentId, membershipStatus: 'active', tenantStatus: 'active',
  grants: { 'conversation.read': 'tenant' }, scopes: [], delegationCeiling: null,
};

describe('operational report filters', () => {
  it('uses a half-open UTC date range and normalizes UUID filters', () => {
    expect(parseOperationalReportFilters({
      from: '2026-09-01', to: '2026-09-30', agentId: agentId.toUpperCase(),
      teamId: '', channel: 'whatsapp', priority: 'high', status: 'open',
    })).toEqual({
      fromAt: new Date('2026-09-01T00:00:00.000Z'), toExclusiveAt: new Date('2026-10-01T00:00:00.000Z'),
      agentId, teamId: null, channel: 'whatsapp', connectionId: null, labelId: null, campaignId: null,
      priority: 'high', status: 'open',
    });
  });

  it('accepts an empty optional filter object and each supported enum family', () => {
    expect(parseOperationalReportFilters({})).toMatchObject({ fromAt: null, toExclusiveAt: null, agentId: null });
    for (const channel of ['whatsapp', 'messenger', 'instagram', 'web_chat', 'custom']) {
      expect(parseOperationalReportFilters({ channel }).channel).toBe(channel);
    }
    for (const priority of ['low', 'normal', 'high', 'urgent']) {
      expect(parseOperationalReportFilters({ priority }).priority).toBe(priority);
    }
    for (const status of ['open', 'pending', 'snoozed', 'resolved', 'archived']) {
      expect(parseOperationalReportFilters({ status }).status).toBe(status);
    }
  });

  it.each([
    null, [], 'not-an-object', { unknown: 'value' }, { from: 7 }, { from: '2026-02-30' },
    { to: '2026-09-22T12:00:00Z' }, { from: '2026-09-02', to: '2026-09-01' },
    { agentId: 7 }, { teamId: 'not-a-uuid' }, { connectionId: '00000000-0000-0000-0000-000000000000' },
    { labelId: 'bad' }, { campaignId: 'bad' }, { channel: 'email' }, { priority: 'critical' }, { status: 'closed' },
  ])('rejects malformed or unsupported filters %#', (query) => {
    expect(() => parseOperationalReportFilters(query)).toThrow(ApiHttpError);
  });

  it('validates readable entity filters without revealing missing identities', async () => {
    const sql = { query: async (_text: string, values: readonly unknown[]) => ({
      rows: [], rowCount: values.includes(labelId) || values.includes(campaignId) || values.includes(teamId) || values.includes(connectionId) ? 1 : 0,
    }) } as unknown as SqlExecutor;
    const filters = parseOperationalReportFilters({ agentId, teamId, channel: 'whatsapp', connectionId, labelId, campaignId });
    await expect(validateReportEntities(sql, principal, filters, [agentId])).resolves.toBeUndefined();
    await expect(validateReportEntities(sql, principal, parseOperationalReportFilters({ labelId: '91000000-0000-4000-8000-000000000006' }), [agentId])).rejects.toThrow(ApiHttpError);
    await expect(validateReportEntities(sql, principal, parseOperationalReportFilters({ campaignId: '91000000-0000-4000-8000-000000000007' }), [agentId])).rejects.toThrow(ApiHttpError);
  });
});
