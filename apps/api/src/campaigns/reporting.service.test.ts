import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import { parseReportFilters } from './campaign-request.js';
import { CampaignReportingService } from './reporting.service.js';

function harness(report: Record<string, unknown>) {
  const sql = { query: vi.fn().mockResolvedValue({ rows: [{ report }], rowCount: 1 }) } as unknown as SqlExecutor;
  const authorization = {
    authorized: vi.fn(async (_session, tenantId, permission, work) =>
      work({ sql, tenantId, principal: {}, decision: {}, scope: 'tenant' })),
  } as unknown as AuthorizationService;
  return { sql, authorization, service: new CampaignReportingService(authorization) };
}

describe('CampaignReportingService', () => {
  it('authorizes report.read and returns the database projection with an unfiltered scope', async () => {
    const report = { generated_at: '2026-09-13T10:00:00.000Z', campaigns: [], trend: [] };
    const { sql, authorization, service } = harness(report);

    await expect(service.report({ userId: 'user-1' } as never, 'tenant-1')).resolves.toEqual({
      ...report, filters: { from: null, to: null, channel: null, campaign_id: null },
    });
    expect(authorization.authorized).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'report.read', expect.any(Function));
    const [text, values] = vi.mocked(sql.query).mock.calls[0] ?? [];
    expect(text).toContain('campaign_report_rows');
    expect(text).toContain('trend_rows');
    expect(values).toEqual([null, null, null, null]);
  });

  it('binds the parsed scope as query parameters and echoes it as requested', async () => {
    const { sql, service } = harness({ campaigns: [] });
    const filters = parseReportFilters({
      from: '2026-09-01', to: '2026-09-13', channel: 'whatsapp', campaignId: '11111111-1111-4111-8111-111111111111',
    });

    const value = await service.report({ userId: 'user-1' } as never, 'tenant-1', filters);
    expect(value.filters).toEqual({
      from: '2026-09-01', to: '2026-09-13', channel: 'whatsapp', campaign_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(vi.mocked(sql.query).mock.calls[0]?.[1]).toEqual([
      '2026-09-01T00:00:00.000Z', '2026-09-14T00:00:00.000Z', 'whatsapp', '11111111-1111-4111-8111-111111111111',
    ]);
  });
});
