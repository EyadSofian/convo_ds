import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { ApiConfig } from '../config.js';
import { AutomationService } from './automation.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const automationId = '22222222-2222-4222-8222-222222222222';
const workflow = { version: 1, trigger: { type: 'manual', config: {} }, target: { type: 'single_customer', config: {} }, steps: [], safety: { approvalRequired: false, duplicateWindowSeconds: 60 } } as never;
const raw = (overrides: Record<string, unknown> = {}) => ({ id: automationId, name: 'Alpha', description: null, template_key: null, state: 'draft', workflow, timezone: 'UTC', next_run_at: null, last_run_at: null, version: 1, ...overrides });
const config = { secrets: { idempotencyHash: 'automation-test-secret-value-with-at-least-32-bytes' } } as unknown as ApiConfig;
const session = { userId: 'user-1' } as never;

function harness(query: SqlExecutor['query']) {
  const sql = { query: vi.fn(query) } as unknown as SqlExecutor;
  const authorization = { authorized: vi.fn(async (_session, _tenant, _permission, work) => work({ sql, tenantId, principal: {}, decision: {}, scope: 'tenant' })) } as unknown as AuthorizationService;
  return { sql, service: new AutomationService(authorization, config) };
}

describe('AutomationService defensive paths', () => {
  it('returns empty and bounded definition/run pages and resumes from an opaque cursor', async () => {
    const rows = [raw({ id: automationId, name: 'Alpha', cursor_value: 'alpha' }), raw({ id: '33333333-3333-4333-8333-333333333333', name: 'Bravo', cursor_value: 'bravo' })];
    const { service } = harness(async <T>(text: string) => {
      if (text.includes('FROM automations')) return { rows: rows as T[], rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    });
    const first = await service.list(session, tenantId, { search: 'a', state: null, sort: 'name_asc', cursor: null, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const resumed = await service.list(session, tenantId, { search: 'a', state: null, sort: 'name_asc', cursor: first.nextCursor, limit: 1 });
    expect(resumed.items).toHaveLength(1);
    expect(resumed.nextCursor).toBeTruthy();
    await service.list(session, tenantId, { search: null, state: null, sort: 'name_desc', cursor: null, limit: 1 });

    const emptyService = harness(async <T>(text: string) => text.includes('FROM automations') ? { rows: [] as T[], rowCount: 0 } : { rows: [], rowCount: 0 });
    const empty = await emptyService.service.list(session, tenantId, { search: 'none', state: 'archived', sort: 'updated_desc', cursor: null, limit: 25 });
    expect(empty).toEqual({ items: [], nextCursor: null });

    const runSql = harness(async <T>(text: string) => {
      if (text.includes('FROM automation_runs')) return { rows: [{ id: automationId, cursor_value: '2026-01-01T00:00:00.000Z', status: 'completed' }, { id: '33333333-3333-4333-8333-333333333333', cursor_value: '2025-01-01T00:00:00.000Z', status: 'failed' }] as T[], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    }).service;
    const runs = await runSql.runs(session, tenantId, { cursor: null, limit: 1 });
    expect(runs.items).toHaveLength(1);
    expect(runs.nextCursor).toBeTruthy();
    const nextRuns = await runSql.runs(session, tenantId, { cursor: runs.nextCursor, limit: 1 });
    expect(nextRuns.items).toHaveLength(1);
  });

  it('refuses missing, stale, historical and racing draft deletes', async () => {
    const cases: Array<{ name: string; query: SqlExecutor['query']; code: string }> = [
      { name: 'missing', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) as SqlExecutor['query'], code: 'resource_not_found' },
      { name: 'stale', query: vi.fn(async <T>(text: string) => text.includes('FOR UPDATE') ? { rows: [raw({ version: 2 })] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }) as SqlExecutor['query'], code: 'automation_version_conflict' },
      { name: 'history', query: vi.fn(async <T>(text: string) => text.includes('FOR UPDATE') ? { rows: [raw()] as T[], rowCount: 1 } : text.includes('automation_runs') ? { rows: [{ id: automationId }] as T[], rowCount: 1 } : { rows: [], rowCount: 0 }) as SqlExecutor['query'], code: 'automation_has_execution_history' },
      { name: 'race', query: vi.fn(async <T>(text: string) => text.includes('FOR UPDATE') ? { rows: [raw()] as T[], rowCount: 1 } : text.startsWith('DELETE FROM automations') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }) as SqlExecutor['query'], code: 'automation_version_conflict' },
    ];
    for (const item of cases) {
      const { service } = harness(item.query);
      await expect(service.deleteDraft(session, tenantId, automationId, 1)).rejects.toMatchObject({ code: item.code });
    }
  });
});
