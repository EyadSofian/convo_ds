import { describe, expect, it, vi } from 'vitest';
import type { Principal, SqlExecutor } from '@convo/domain';
import { assertSupervisor, requireScopedSupervisorAgent, scopedReportableAgents, scopedReportableTeams, scopedSupervisorAgents } from './supervisor-directory.js';

const member = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const inbox = '33333333-3333-4333-8333-333333333333';
const row = { membership_id: member, name: 'Ahmed', email: 'ahmed@example.test', teams: ['Support'] };

function principal(scope: 'none' | 'own' | 'scoped' | 'tenant', scopes: Principal['scopes'] = []): Principal {
  return { membershipId: member, membershipStatus: 'active', tenantStatus: 'active', grants: scope === 'none' ? {} : { 'conversation.read': scope }, scopes, delegationCeiling: null };
}
function sql(rows: readonly Record<string, unknown>[] = [row]): SqlExecutor {
  return { query: vi.fn(async <T>() => ({ rows: rows as T[], rowCount: rows.length })) } as unknown as SqlExecutor;
}

describe('supervisor directory scope boundaries', () => {
  it('allows only scoped/tenant readers to use the supervisor directory', async () => {
    expect(() => assertSupervisor(principal('none'))).toThrowError(/not allowed/i);
    expect(() => assertSupervisor(principal('own'))).toThrowError(/not allowed/i);
    expect(() => assertSupervisor(principal('scoped'))).not.toThrow();
    expect(await scopedSupervisorAgents(sql(), principal('tenant'))).toEqual([{ membershipId: member, name: 'Ahmed', email: 'ahmed@example.test', teams: ['Support'] }]);
  });

  it('returns self for own report scope and none for no report scope', async () => {
    const own = await scopedReportableAgents(sql(), principal('own'));
    expect(own[0]?.membershipId).toBe(member);
    expect(await scopedReportableAgents(sql(), principal('none'))).toEqual([]);
  });

  it('uses tenant and scoped team/inbox queries for reportable teams', async () => {
    expect(await scopedReportableTeams(sql([{ team_id: team, name: 'Support' }]), principal('tenant'))).toEqual([{ teamId: team, name: 'Support' }]);
    expect(await scopedReportableTeams(sql([{ team_id: team, name: 'Support' }]), principal('scoped', [{ type: 'team', id: team }, { type: 'inbox', id: inbox }]))).toEqual([{ teamId: team, name: 'Support' }]);
  });

  it('finds only agents in the caller scope', async () => {
    const supervisor = principal('scoped', [{ type: 'team', id: team }]);
    await expect(requireScopedSupervisorAgent(sql(), supervisor, member)).resolves.toMatchObject({ membershipId: member });
    await expect(requireScopedSupervisorAgent(sql(), supervisor, inbox)).rejects.toMatchObject({ status: 404 });
  });
});
