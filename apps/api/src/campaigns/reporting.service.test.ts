import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import { CampaignReportingService } from './reporting.service.js';

describe('CampaignReportingService', () => {
  it('authorizes report.read and returns the database projection unchanged', async () => {
    const report = { generated_at: '2026-09-13T10:00:00.000Z', campaigns: [] };
    const sql = { query: vi.fn().mockResolvedValue({ rows: [{ report }], rowCount: 1 }) } as unknown as SqlExecutor;
    const authorization = {
      authorized: vi.fn(async (_session, tenantId, permission, work) =>
        work({ sql, tenantId, principal: {}, decision: {}, scope: 'tenant' })),
    } as unknown as AuthorizationService;
    const service = new CampaignReportingService(authorization);

    await expect(service.report({ userId: 'user-1' } as never, 'tenant-1')).resolves.toBe(report);
    expect(authorization.authorized).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'report.read', expect.any(Function));
    expect(vi.mocked(sql.query).mock.calls[0]?.[0]).toContain('campaign_report_rows');
  });
});
